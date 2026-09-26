/**
 * Participações de leads nas automações (`automation_runs`): cancelamentos, recuperação de execuções
 * abandonadas, contadores e listagem. Tudo em SQL sobre o PostgreSQL: nada fica em memória.
 */
import { sql } from 'kysely';
import type { AutomationRunCounts, AutomationRunItem, AutomationStepRunItem } from '../../../shared/api';
import { AUTOMATION_RUN_STATUSES } from '../../../shared/automations';
import type { Db } from '../../db';
import { audit } from '../../lib/audit';
import { STUCK_AFTER_MINUTES } from './schedule';

/** Motivos de cancelamento e de falha guardados em `cancel_reason`. Os textos ficam em `RUN_REASON_LABELS`. */
export const REASON = {
  replied: 'lead_respondeu',
  archived: 'automacao_arquivada',
  blocked: 'lead_bloqueado',
  anonymized: 'lead_anonimizado',
  noNumber: 'numero_removido',
  interrupted: 'executor_interrompido',
  campaignStopped: 'campanha_encerrada',
  listRemoved: 'lista_removida',
  listExhausted: 'lista_esgotada',
  listArchived: 'lista_arquivada',
  leadTaken: 'lead_indisponivel',
  endDate: 'data_final',
} as const;

export interface EndedRun {
  id: number;
  automation_id: number;
  lead_id: number;
  current_step: number;
}

export interface CancelFilter {
  automationId?: number;
  campaignId?: number;
  /** Só as participações que ainda não enviaram o primeiro contato (etapa 1). */
  firstContactOnly?: boolean;
  leadId?: number;
  leadIds?: number[];
  instanceId?: number;
  /** Participações cujo número foi excluído (instance_id vazio). */
  withoutNumber?: boolean;
  /** Participações de automações arquivadas. */
  inArchivedAutomations?: boolean;
}

/**
 * Cancela as participações em andamento (pendentes ou em execução) que combinam com o filtro. Também
 * cancela a tentativa de etapa que ainda não começou. Uma etapa que já está sendo enviada não é mexida:
 * ela termina e o executor grava o resultado (a mensagem que saiu não pode ser desfeita).
 */
export async function cancelLiveRuns(db: Db, filter: CancelFilter, reason: string): Promise<EndedRun[]> {
  if (filter.leadIds && filter.leadIds.length === 0) return [];
  let query = db
    .updateTable('automation_runs')
    .set({
      status: 'cancelled',
      cancelled_at: sql`now()`,
      cancel_reason: reason,
      next_run_at: null,
      updated_at: sql`now()`,
    })
    .where('status', 'in', ['pending', 'running']);
  if (filter.automationId !== undefined) query = query.where('automation_id', '=', filter.automationId);
  if (filter.campaignId !== undefined) query = query.where('campaign_id', '=', filter.campaignId);
  if (filter.firstContactOnly) query = query.where('current_step', '=', 1);
  if (filter.leadId !== undefined) query = query.where('lead_id', '=', filter.leadId);
  if (filter.leadIds) query = query.where('lead_id', 'in', filter.leadIds);
  if (filter.instanceId !== undefined) query = query.where('instance_id', '=', filter.instanceId);
  if (filter.withoutNumber) query = query.where('instance_id', 'is', null);
  if (filter.inArchivedAutomations) {
    query = query.where(
      'automation_id',
      'in',
      db.selectFrom('automations').select('id').where('status', '=', 'archived'),
    );
  }
  const ended = await query.returning(['id', 'automation_id', 'lead_id', 'current_step']).execute();
  if (ended.length) {
    await db
      .updateTable('automation_step_runs')
      .set({ status: 'cancelled', finished_at: sql`now()`, updated_at: sql`now()` })
      .where(
        'automation_run_id',
        'in',
        ended.map((r) => r.id),
      )
      .where('status', '=', 'pending')
      .execute();
  }
  return ended;
}

/** Uma linha de auditoria por participação cancelada (sem nome nem telefone do lead). */
export async function auditCancelled(
  db: Db,
  ended: EndedRun[],
  reason: string,
  by: { userId?: string | null; ip?: string | null } = {},
): Promise<void> {
  for (const run of ended) {
    await audit(db, {
      userId: by.userId ?? null,
      action: 'cancelou_execucao_automacao',
      entity: 'automacao',
      entityId: run.automation_id,
      details: { execucao: run.id, lead: run.lead_id, etapa: run.current_step, motivo: reason },
      ip: by.ip ?? null,
    });
  }
}

/**
 * O lead respondeu por um número: cancela na hora as participações DELE naquele número. Participações
 * de outros números (ou de outros leads) continuam.
 */
export async function cancelRunsOnReply(db: Db, leadId: number, instanceId: number): Promise<number> {
  const ended = await db.transaction().execute(async (trx) => {
    const rows = await cancelLiveRuns(trx, { leadId, instanceId }, REASON.replied);
    await auditCancelled(trx, rows, REASON.replied);
    return rows;
  });
  return ended.length;
}

/** Os leads entraram em "não contatar": cancela as participações deles. */
export async function cancelRunsForBlockedLeads(db: Db, leadIds: number[]): Promise<number> {
  const rows = await cancelLiveRuns(db, { leadIds }, REASON.blocked);
  await auditCancelled(db, rows, REASON.blocked);
  return rows.length;
}

/** Participações que nunca mais poderão enviar: número excluído ou automação arquivada. */
export async function cancelOrphanedRuns(db: Db): Promise<number> {
  const noNumber = await cancelLiveRuns(db, { withoutNumber: true }, REASON.noNumber);
  await auditCancelled(db, noNumber, REASON.noNumber);
  const archived = await cancelLiveRuns(db, { inArchivedAutomations: true }, REASON.archived);
  await auditCancelled(db, archived, REASON.archived);
  return noNumber.length + archived.length;
}

/**
 * Recupera participações abandonadas: o processo caiu no meio de um envio. NÃO reenvia: não há como saber
 * se a Evolution chegou a mandar a mensagem, e reenviar poderia duplicá-la para o cliente. A participação
 * e a tentativa da etapa viram "failed" com o motivo `executor_interrompido`, para o gestor decidir.
 */
export async function recoverStuckRuns(db: Db): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const stuck = await trx
      .updateTable('automation_runs')
      .set({
        status: 'failed',
        next_run_at: null,
        cancel_reason: REASON.interrupted,
        updated_at: sql`now()`,
      })
      .where('status', '=', 'running')
      .where('updated_at', '<', sql<Date>`now() - make_interval(mins => ${STUCK_AFTER_MINUTES}::int)`)
      .returning(['id', 'automation_id', 'lead_id', 'current_step'])
      .execute();
    if (!stuck.length) return 0;
    await trx
      .updateTable('automation_step_runs')
      .set({
        status: 'failed',
        error: `${REASON.interrupted}: o processo parou no meio do envio; a mensagem não foi reenviada e pode ou não ter sido entregue`,
        finished_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(
        'automation_run_id',
        'in',
        stuck.map((r) => r.id),
      )
      .where('status', '=', 'running')
      .execute();
    for (const run of stuck) {
      await audit(trx, {
        userId: null,
        action: 'falhou_execucao_automacao',
        entity: 'automacao',
        entityId: run.automation_id,
        details: { execucao: run.id, lead: run.lead_id, etapa: run.current_step, motivo: REASON.interrupted },
      });
    }
    return stuck.length;
  });
}

// ---------- leitura ----------

const emptyCounts = (): AutomationRunCounts => ({
  pending: 0,
  running: 0,
  completed: 0,
  cancelled: 0,
  failed: 0,
});

export interface RunSummary {
  counts: AutomationRunCounts;
  lastRunAt: Date | null;
}

/** Contadores por situação e a data da última participação, de várias automações de uma vez. */
export async function runSummaries(db: Db, automationIds: number[]): Promise<Map<number, RunSummary>> {
  const summaries = new Map<number, RunSummary>();
  for (const id of automationIds) summaries.set(id, { counts: emptyCounts(), lastRunAt: null });
  if (!automationIds.length) return summaries;
  const rows = await db
    .selectFrom('automation_runs')
    .select(['automation_id', 'status'])
    .select((eb) => [eb.fn.countAll<number>().as('n'), eb.fn.max('created_at').as('last')])
    .where('automation_id', 'in', automationIds)
    .groupBy(['automation_id', 'status'])
    .execute();
  for (const row of rows) {
    const summary = summaries.get(row.automation_id);
    if (!summary || !(AUTOMATION_RUN_STATUSES as readonly string[]).includes(row.status)) continue;
    summary.counts[row.status] = Number(row.n);
    if (row.last && (!summary.lastRunAt || row.last > summary.lastRunAt)) summary.lastRunAt = row.last;
  }
  return summaries;
}

/** As participações mais recentes de uma automação (ou só a `runId`), com o que aconteceu em cada etapa. */
export async function listRuns(
  db: Db,
  automationId: number,
  limit: number,
  filter: { runId?: number; campaignId?: number } = {},
): Promise<AutomationRunItem[]> {
  let base = db
    .selectFrom('automation_runs as r')
    .leftJoin('leads as l', 'l.id', 'r.lead_id')
    .leftJoin('wa_instances as i', 'i.id', 'r.instance_id')
    .select([
      'r.id',
      'r.automation_id',
      'r.lead_id',
      'r.instance_id',
      'r.campaign_id',
      'r.status',
      'r.current_step',
      'r.started_at',
      'r.next_run_at',
      'r.completed_at',
      'r.cancelled_at',
      'r.cancel_reason',
      'l.company as lead_company',
      'l.name as lead_name',
      'l.anonymized_at as lead_anonymized_at',
      'i.name as instance_name',
      'i.nickname as instance_nickname',
    ])
    .where('r.automation_id', '=', automationId);
  if (filter.runId !== undefined) base = base.where('r.id', '=', filter.runId);
  if (filter.campaignId !== undefined) base = base.where('r.campaign_id', '=', filter.campaignId);
  const runs = await base.orderBy('r.id', 'desc').limit(limit).execute();
  if (!runs.length) return [];

  const stepRuns = await db
    .selectFrom('automation_step_runs as sr')
    .leftJoin('automation_steps as s', 's.id', 'sr.step_id')
    .select([
      'sr.automation_run_id',
      'sr.step_id',
      's.position',
      'sr.status',
      'sr.attempts',
      'sr.error',
      'sr.message_id',
      'sr.scheduled_at',
      'sr.finished_at',
      'sr.audio_id',
      'sr.audio_label',
    ])
    .where(
      'sr.automation_run_id',
      'in',
      runs.map((r) => r.id),
    )
    .orderBy('sr.id')
    .execute();
  const byRun = new Map<number, AutomationStepRunItem[]>();
  for (const sr of stepRuns) {
    const list = byRun.get(sr.automation_run_id) ?? [];
    list.push({
      stepId: sr.step_id,
      position: sr.position,
      status: sr.status,
      attempts: sr.attempts,
      error: sr.error,
      messageId: sr.message_id,
      scheduledAt: sr.scheduled_at.toISOString(),
      finishedAt: sr.finished_at ? sr.finished_at.toISOString() : null,
      audio: sr.audio_label ? { id: sr.audio_id, label: sr.audio_label } : null,
    });
    byRun.set(sr.automation_run_id, list);
  }

  return runs.map((r) => ({
    id: r.id,
    automationId: r.automation_id,
    campaignId: r.campaign_id,
    lead: r.lead_id
      ? {
          id: r.lead_id,
          label: r.lead_anonymized_at ? 'Anonimizado' : r.lead_company || r.lead_name || `Lead ${r.lead_id}`,
          name: r.lead_anonymized_at ? null : r.lead_name || null,
          company: r.lead_anonymized_at ? null : r.lead_company || null,
        }
      : null,
    instance: r.instance_id
      ? { id: r.instance_id, label: r.instance_nickname || r.instance_name || `Número ${r.instance_id}` }
      : null,
    status: r.status,
    currentStep: r.current_step,
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    nextRunAt: r.next_run_at ? r.next_run_at.toISOString() : null,
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    cancelledAt: r.cancelled_at ? r.cancelled_at.toISOString() : null,
    reason: r.cancel_reason,
    steps: byRun.get(r.id) ?? [],
  }));
}
