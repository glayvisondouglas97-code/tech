/**
 * Automações: camada de serviço usada pelas rotas.
 *
 * O CRUD da automação principal (listar, buscar, criar, atualizar, ativar/pausar e arquivar) usa o banco.
 * As etapas (criar, alterar, excluir e reordenar) ficam em `steps.ts`; aqui elas só são lidas, junto da
 * automação, e conferidas antes de ativar. Quem executa uma automação ativa é o executor
 * (`executor.ts`, chamado pelo job do scheduler). Nada aqui chama a Evolution.
 */
import { sql } from 'kysely';
import { automationProblems } from '../../../shared/automations';
import type { AuthUser } from '../../auth/sessions';
import type { Db } from '../../db';
import type { Automation, AutomationStep as AutomationStepRow } from '../../db/schema';
import { audit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { endCampaignsOfAutomation } from './queue';
import { cancelLiveRuns, REASON, type RunSummary, runSummaries } from './runs';
import type {
  AutomationChanges,
  AutomationItem,
  AutomationSettableStatus,
  AutomationStatus,
  AutomationStep,
  AutomationTrigger,
  NewAutomation,
} from './types';

const NOT_FOUND = 'Automação não encontrada.';

/**
 * Mudanças de situação permitidas. Rascunho e pausada ativam; só a ativa pausa; qualquer uma que
 * ainda não foi arquivada pode ser arquivada; arquivada não volta.
 */
const STATUS_CHANGES: Record<AutomationStatus, readonly AutomationStatus[]> = {
  draft: ['active', 'archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: [],
};

export function canChangeStatus(from: AutomationStatus, to: AutomationStatus): boolean {
  return STATUS_CHANGES[from].includes(to);
}

const STATUS_WORDS: Record<AutomationStatus, string> = {
  draft: 'em rascunho',
  active: 'ativa',
  paused: 'pausada',
  archived: 'arquivada',
};

/** Explica, para quem usa o sistema, por que `canChangeStatus(from, to)` deu falso. */
export function statusChangeProblem(from: AutomationStatus, to: AutomationStatus): string {
  if (from === 'archived') return 'Uma automação arquivada não volta a ser usada.';
  if (from === to) return `A automação já está ${STATUS_WORDS[to]}.`;
  if (to === 'paused') return 'Só uma automação ativa pode ser pausada.';
  return 'Essa mudança de situação não é permitida.';
}

// ---------- leitura ----------

type AutomationRow = Automation & { creator_name: string | null };

const withCreator = (db: Db) =>
  db
    .selectFrom('automations as a')
    .leftJoin('users as u', 'u.id', 'a.created_by')
    .selectAll('a')
    .select('u.name as creator_name');

export function stepDto(step: AutomationStepRow): AutomationStep {
  return {
    id: step.id,
    position: step.position,
    actionType: step.action_type,
    delaySeconds: step.delay_seconds,
    messageText: step.message_text,
    audioId: step.audio_id,
    audioMode: step.audio_mode,
    conditions: step.conditions,
  };
}

function automationDto(row: AutomationRow, steps: AutomationStepRow[], runs: RunSummary): AutomationItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    trigger: row.trigger_type,
    steps: steps.map(stepDto),
    runs: runs.counts,
    lastRunAt: runs.lastRunAt ? runs.lastRunAt.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by ? { id: row.created_by, name: row.creator_name ?? '—' } : null,
  };
}

/** Etapas de várias automações de uma vez, já na ordem (por automação e posição). */
export async function loadSteps(db: Db, automationIds: number[]): Promise<Map<number, AutomationStepRow[]>> {
  const byAutomation = new Map<number, AutomationStepRow[]>();
  if (!automationIds.length) return byAutomation;
  const rows = await db
    .selectFrom('automation_steps')
    .selectAll()
    .where('automation_id', 'in', automationIds)
    .orderBy('automation_id')
    .orderBy('position')
    .execute();
  for (const row of rows) {
    const list = byAutomation.get(row.automation_id) ?? [];
    list.push(row);
    byAutomation.set(row.automation_id, list);
  }
  return byAutomation;
}

async function loadAutomation(db: Db, id: number): Promise<AutomationItem> {
  const row = await withCreator(db).where('a.id', '=', id).executeTakeFirst();
  if (!row) throw notFound(NOT_FOUND);
  const steps = await loadSteps(db, [id]);
  const runs = await runSummaries(db, [id]);
  return automationDto(row, steps.get(id) ?? [], runs.get(id) as RunSummary);
}

/** Trava a linha até o fim da transação: duas mudanças ao mesmo tempo não se atropelam. */
export async function lockAutomation(db: Db, id: number): Promise<Automation> {
  const row = await db
    .selectFrom('automations')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw notFound(NOT_FOUND);
  return row;
}

/** Nome repetido entre as automações não arquivadas (índice único por nome, sem diferenciar maiúsculas). */
function nameTaken(error: unknown): never {
  const e = error as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'automations_name_key') {
    throw conflict('Já existe uma automação com esse nome.');
  }
  throw error;
}

// ---------- operações ----------
// Quem pode usar cada uma já foi conferido na rota (`requirePermission(req, 'manageAutomations')`).

/** Lista as automações, das mais novas para as mais antigas. Por padrão, sem as arquivadas. */
export async function listAutomations(db: Db, _user: AuthUser, archived = false): Promise<AutomationItem[]> {
  const rows = await withCreator(db)
    .where('a.archived_at', archived ? 'is not' : 'is', null)
    .orderBy('a.id', 'desc')
    .execute();
  const ids = rows.map((r) => r.id);
  const steps = await loadSteps(db, ids);
  const runs = await runSummaries(db, ids);
  return rows.map((row) => automationDto(row, steps.get(row.id) ?? [], runs.get(row.id) as RunSummary));
}

/** Uma automação com as etapas (arquivada também pode ser vista). 404 se não existir. */
export async function getAutomation(db: Db, _user: AuthUser, id: number): Promise<AutomationItem> {
  return loadAutomation(db, id);
}

/** Cria como rascunho, sem etapas. 409 se já houver outra (não arquivada) com o mesmo nome. */
export async function createAutomation(
  db: Db,
  user: AuthUser,
  input: NewAutomation,
  ip: string | null,
): Promise<AutomationItem> {
  const id = await db.transaction().execute(async (trx) => {
    const created = await trx
      .insertInto('automations')
      .values({
        name: input.name,
        description: input.description,
        trigger_type: input.trigger,
        created_by: user.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(nameTaken);
    await audit(trx, {
      userId: user.id,
      action: 'criou_automacao',
      entity: 'automacao',
      entityId: created.id,
      details: { nome: input.name, gatilho: input.trigger },
      ip,
    });
    return created.id;
  });
  return loadAutomation(db, id);
}

/**
 * Altera só o que foi enviado e mudou de verdade. Arquivada não se edita (409); nome repetido também (409).
 * As etapas não passam por aqui.
 */
export async function updateAutomation(
  db: Db,
  user: AuthUser,
  id: number,
  changes: AutomationChanges,
  ip: string | null,
): Promise<AutomationItem> {
  await db.transaction().execute(async (trx) => {
    const current = await lockAutomation(trx, id);
    if (current.status === 'archived') throw conflict('Uma automação arquivada não pode ser alterada.');

    const set: { name?: string; description?: string | null; trigger_type?: AutomationTrigger } = {};
    if (changes.name !== undefined && changes.name !== current.name) set.name = changes.name;
    if (changes.description !== undefined && changes.description !== current.description) {
      set.description = changes.description;
    }
    if (changes.trigger !== undefined && changes.trigger !== current.trigger_type) {
      set.trigger_type = changes.trigger;
    }
    const fields = Object.keys(set);
    if (!fields.length) return;

    await trx
      .updateTable('automations')
      .set({ ...set, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute()
      .catch(nameTaken);
    const labels = { name: 'nome', description: 'descrição', trigger_type: 'gatilho' } as const;
    await audit(trx, {
      userId: user.id,
      action: 'alterou_automacao',
      entity: 'automacao',
      entityId: id,
      details: { campos: fields.map((f) => labels[f as keyof typeof labels]) },
      ip,
    });
  });
  return loadAutomation(db, id);
}

/**
 * Ativa ou pausa, conferindo `canChangeStatus` com a linha travada. 409 se a mudança não for permitida
 * ou se, ao ativar, faltar etapa ou houver etapa incompleta. Ativa não executa nada (ainda não há executor).
 */
export async function setAutomationStatus(
  db: Db,
  user: AuthUser,
  id: number,
  status: AutomationSettableStatus,
  ip: string | null,
): Promise<AutomationItem> {
  await db.transaction().execute(async (trx) => {
    const current = await lockAutomation(trx, id);
    if (!canChangeStatus(current.status, status)) throw conflict(statusChangeProblem(current.status, status));
    if (status === 'active') {
      if (current.trigger_type === 'lead_created') {
        throw conflict(
          'O gatilho "quando um lead for criado" ainda não está ligado: escolha "quando um lead for chamado" ou "manual".',
        );
      }
      // Só ativa com pelo menos uma etapa, e todas completas (a mesma conferência que a interface faz).
      const steps = (await loadSteps(trx, [id])).get(id) ?? [];
      const problems = automationProblems(steps.map(stepDto));
      if (problems.length) throw conflict(`Não dá para ativar. ${problems.join(' ')}`, { problems });
      // Etapa que sorteia áudio precisa de pelo menos um áudio ativo na biblioteca.
      if (steps.some((st) => st.action_type === 'send_audio' && st.audio_mode === 'random')) {
        const active = await trx
          .selectFrom('wa_audios')
          .select('id')
          .where('active', '=', true)
          .where('media_path', '<>', '')
          .limit(1)
          .executeTakeFirst();
        if (!active) {
          throw conflict(
            'Não dá para ativar: uma etapa sorteia áudio e não há nenhum áudio ativo na biblioteca.',
          );
        }
      }
    }
    await trx
      .updateTable('automations')
      .set({ status, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
    await audit(trx, {
      userId: user.id,
      action: status === 'active' ? 'ativou_automacao' : 'pausou_automacao',
      entity: 'automacao',
      entityId: id,
      ip,
    });
  });
  return loadAutomation(db, id);
}

/**
 * Arquiva: status "archived" e a data em archived_at. Nada é apagado (etapas e histórico ficam) e a
 * automação não volta. 409 se já estava arquivada.
 */
export async function archiveAutomation(
  db: Db,
  user: AuthUser,
  id: number,
  ip: string | null,
): Promise<AutomationItem> {
  await db.transaction().execute(async (trx) => {
    const current = await lockAutomation(trx, id);
    if (!canChangeStatus(current.status, 'archived')) {
      throw conflict(statusChangeProblem(current.status, 'archived'));
    }
    await trx
      .updateTable('automations')
      .set({ status: 'archived', archived_at: sql`now()`, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
    // Arquivada nunca envia: as participações em andamento são canceladas (o histórico fica).
    // Ordem das travas: campanha, depois participações (a mesma de encerrar e da reserva de leads).
    await endCampaignsOfAutomation(trx, id, REASON.archived, user.id, ip);
    const cancelled = await cancelLiveRuns(trx, { automationId: id }, REASON.archived);
    await audit(trx, {
      userId: user.id,
      action: 'arquivou_automacao',
      entity: 'automacao',
      entityId: id,
      details: { estavaEm: current.status, execucoes_canceladas: cancelled.length },
      ip,
    });
  });
  return loadAutomation(db, id);
}
