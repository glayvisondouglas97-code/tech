/**
 * Gatilhos: o que faz um lead ENTRAR numa automação (criar a participação, `automation_runs`).
 * Aqui só se cria a participação e se calcula quando a primeira etapa deve agir; quem envia é o
 * executor (`executor.ts`), chamado pelo job do scheduler. Nenhum timer é criado.
 *
 * - `lead_called`: ligado ao botão "Chamar" (ver `whatsapp/leads.ts`).
 * - `manual`: `POST /api/automations/:id/run`, um lead por pedido.
 * - `lead_created`: NÃO ligado. O único ponto onde leads nascem é a importação de planilhas (milhares de
 *   leads de uma vez, ainda sem nenhuma conversa nem número), e disparar mensagens a partir dali seria
 *   disparo em massa. Fica para uma etapa própria, com critério claro.
 */
import { sql } from 'kysely';
import type { AutomationRunItem, ManualRunInput } from '../../../shared/api';
import { automationProblems } from '../../../shared/automations';
import type { AuthUser } from '../../auth/sessions';
import type { Db } from '../../db';
import { audit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { visibleNumber } from '../whatsapp/access';
import { ensureConnected } from '../whatsapp/messaging';
import { auditContactLimit, checkInstanceDailyQuota, limitReachedError, quotaDate } from '../whatsapp/quota';
import { INELIGIBLE_MESSAGES, leadEligibility } from './eligibility';
import { listRuns } from './runs';
import { scheduleAfter } from './schedule';
import { assertNotSystem, loadSteps, stepDto } from './service';

interface NewRun {
  automationId: number;
  leadId: number;
  instanceId: number;
  startedBy: string | null;
  /** Quando o gatilho aconteceu (o "Chamar" terminou, ou o gestor iniciou). A espera da 1ª etapa conta daqui. */
  at: Date;
  firstDelaySeconds: number;
}

/**
 * Cria a participação (pendente, na etapa 1) com o momento da primeira etapa. Devolve null se o lead já
 * participa desta automação: o índice único parcial (`automation_runs_live_key`) é quem garante, mesmo com
 * dois pedidos ao mesmo tempo.
 */
async function createRun(db: Db, run: NewRun): Promise<number | null> {
  const created = await sql<{ id: number }>`
    INSERT INTO automation_runs (automation_id, lead_id, instance_id, started_by, status, current_step, started_at, next_run_at)
    VALUES (${run.automationId}, ${run.leadId}, ${run.instanceId}, ${run.startedBy}, 'pending', 1, ${run.at},
      ${scheduleAfter(run.at, run.firstDelaySeconds)})
    ON CONFLICT (automation_id, lead_id) WHERE status IN ('pending', 'running') DO NOTHING
    RETURNING id`.execute(db);
  return created.rows[0]?.id ?? null;
}

export interface LeadCalledEvent {
  leadId: number;
  /** O número que fez o "Chamar": é por ele que a automação vai falar. */
  instanceId: number;
  /** Quem chamou. */
  userId: string | null;
  at: Date;
  ip?: string | null;
}

/**
 * Um "Chamar" foi concluído (a mensagem inicial saiu): inicia as automações ativas com gatilho
 * `lead_called`. Regras:
 * - não inicia se o lead já participa da automação (em andamento) nem se ela já foi concluída para ele:
 *   chamar de novo não repete a sequência inteira;
 * - só inicia automação com pelo menos uma etapa, todas completas;
 * - lead em "não contatar" ou anonimizado não entra.
 * Devolve quantas participações foram criadas.
 */
export async function triggerLeadCalled(db: Db, event: LeadCalledEvent): Promise<number> {
  const automations = await db
    .selectFrom('automations')
    .select('id')
    .where('trigger_type', '=', 'lead_called')
    .where('status', '=', 'active')
    .where('system_key', 'is', null)
    .orderBy('id')
    .execute();
  if (!automations.length) return 0;
  if (!('lead' in (await leadEligibility(db, event.leadId)))) return 0;
  const instance = await db
    .selectFrom('wa_instances')
    .select('id')
    .where('id', '=', event.instanceId)
    .executeTakeFirst();
  if (!instance) return 0;

  let created = 0;
  for (const { id: automationId } of automations) {
    const steps = ((await loadSteps(db, [automationId])).get(automationId) ?? []).map(stepDto);
    if (automationProblems(steps).length) continue;
    const already = await db
      .selectFrom('automation_runs')
      .select('id')
      .where('automation_id', '=', automationId)
      .where('lead_id', '=', event.leadId)
      .where('status', 'in', ['pending', 'running', 'completed'])
      .executeTakeFirst();
    if (already) continue;
    const runId = await createRun(db, {
      automationId,
      leadId: event.leadId,
      instanceId: event.instanceId,
      startedBy: event.userId,
      at: event.at,
      firstDelaySeconds: steps[0]?.delaySeconds ?? 0,
    });
    if (runId === null) continue;
    created += 1;
    await audit(db, {
      userId: event.userId,
      action: 'criou_execucao_automacao',
      entity: 'automacao',
      entityId: automationId,
      details: { execucao: runId, lead: event.leadId, numero: event.instanceId, gatilho: 'lead_called' },
      ip: event.ip ?? null,
    });
  }
  return created;
}

/**
 * Execução manual: um pedido = um lead, pelo número escolhido. O número precisa estar acessível para quem
 * pede e conectado agora. A automação precisa estar ativa, ser do tipo manual e ter etapas completas.
 * Não faz disparo em massa: não existe versão "vários leads" desta função.
 */
export async function startManualRun(
  db: Db,
  user: AuthUser,
  automationId: number,
  input: ManualRunInput,
  ip: string | null,
): Promise<AutomationRunItem> {
  const automation = await db
    .selectFrom('automations')
    .select(['id', 'status', 'trigger_type', 'system_key'])
    .where('id', '=', automationId)
    .executeTakeFirst();
  if (!automation) throw notFound('Automação não encontrada.');
  assertNotSystem(automation);
  if (automation.status === 'archived') throw conflict('Uma automação arquivada não pode ser executada.');
  if (automation.status !== 'active') throw conflict('A automação precisa estar ativa para ser executada.');
  if (automation.trigger_type !== 'manual') {
    throw conflict('Só automações com o gatilho "manual" são iniciadas por aqui.');
  }

  const instance = await visibleNumber(db, user, input.instanceId);
  const eligibility = await leadEligibility(db, input.leadId);
  if ('reason' in eligibility) {
    const message = INELIGIBLE_MESSAGES[eligibility.reason];
    throw eligibility.reason === 'lead_removido' ? notFound(message) : conflict(message);
  }
  await ensureConnected(db, instance);
  // A execução manual também inicia um contato novo: passa pela MESMA cota diária do número (20, manual + automático).
  // Cota cheia = recusa aqui, antes de criar a participação. (O executor confere de novo na hora de enviar.)
  const quota = await checkInstanceDailyQuota(db, instance.id, quotaDate());
  if (!quota.ok) {
    await auditContactLimit(db, {
      instanceId: instance.id,
      usage: quota.usage,
      origin: 'api',
      situation: 'recusado',
      userId: user.id,
      ip,
    }).catch(() => {});
    throw limitReachedError();
  }

  const steps = ((await loadSteps(db, [automationId])).get(automationId) ?? []).map(stepDto);
  const problems = automationProblems(steps);
  if (problems.length)
    throw conflict(`A automação tem etapa incompleta. ${problems.join(' ')}`, { problems });

  const runId = await createRun(db, {
    automationId,
    leadId: input.leadId,
    instanceId: instance.id,
    startedBy: user.id,
    at: new Date(),
    firstDelaySeconds: steps[0]?.delaySeconds ?? 0,
  });
  if (runId === null) throw conflict('Este lead já está participando desta automação.');
  await audit(db, {
    userId: user.id,
    action: 'iniciou_execucao_manual',
    entity: 'automacao',
    entityId: automationId,
    details: { execucao: runId, lead: input.leadId, numero: instance.id },
    ip,
  });
  const [item] = await listRuns(db, automationId, 1, { runId });
  if (!item) throw notFound('Execução não encontrada.');
  return item;
}
