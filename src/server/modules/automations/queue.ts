/**
 * Fila das campanhas: decide QUEM entra na campanha, POR QUAL NÚMERO e QUANDO. Roda no job do scheduler existente
 * (`jobs/scheduler.ts`, antes do ciclo do executor). Quem envia é sempre o executor (`executor.ts`).
 *
 * Como funciona (nada em memória, nenhum timer por lead):
 * - A campanha guarda só o estado; os leads NÃO são copiados. A cada ciclo, para cada número da campanha, o job
 *   reserva no máximo UM lead: cria um `automation_run` com `campaign_id`, `instance_id` e `next_run_at`
 *   espaçado dentro da janela de horário. Quando esse lead é enviado, o número fica livre para o próximo.
 *   Assim, uma lista de 100 mil leads nunca vira 100 mil linhas: só há uma fila pequena e sempre atual.
 * - RESERVAR NÃO É CONTATAR. Aqui só se PLANEJA (quem entra, por qual número, quando). A cota diária do número (20
 *   contatos, somando manual + automático) vive em `wa_instance_daily_usage` e só conta o que foi ENVIADO, no dia do
 *   envio (`whatsapp/quota.ts`). A vaga é segurada pelo executor, de forma atômica, na hora de enviar. O que esta
 *   fila faz com a cota é LER: número com o dia cheio não recebe lead novo, e o espaçamento dos envios usa a
 *   capacidade que ainda resta HOJE (contatos manuais já feitos incluídos), não o número de reservas.
 * - Número escolhido: entre os que estão conectados e com vaga, os menos usados (uso relativo ao limite, contando
 *   manual + automático) vão primeiro; empate se resolve por sorteio. Número desconectado, cheio ou excluído não
 *   recebe lead novo.
 * - Lead escolhido: o de menor id entre os elegíveis (ordem previsível, sem aleatoriedade). Quem é elegível é definido
 *   num lugar só (`campaign-audience.ts`): lista, filtros, bloqueio, cooldown, participação existente.
 * - AGENDA: só reserva num dia permitido, dentro das datas e antes de a janela de hoje fechar. Antes da data inicial a
 *   campanha está "agendada" (nada é reservado); depois da data final ela termina (`data_final`).
 */
import { sql } from 'kysely';
import type { Db } from '../../db';
import type { AutomationCampaign } from '../../db/schema';
import { audit } from '../../lib/audit';
import { shuffled } from '../../lib/shuffle';
import { isEvolutionConfigured } from '../whatsapp/evolution';
import { effectiveLimit, instanceUsage, poolWithCapacity } from '../whatsapp/quota';
import { audienceConfigOf, getCampaignEligibleLeads, leadFreeOfOtherCampaign } from './campaign-audience';
import { auditCancelled, cancelLiveRuns, REASON } from './runs';
import { scheduleAfter } from './schedule';
import { dayAllowed, planSlot, scheduleOf, spDate, spTime } from './window';

/** Espaço de chaves dos advisory locks das reservas (uma trava por número de WhatsApp). */
const LOCK_NAMESPACE = 720_100;

/** No máximo quantos leads o job reserva por ciclo (todas as campanhas somadas). */
export const MAX_RESERVATIONS_PER_CYCLE = 10;

export type Reservation =
  | { kind: 'reserved'; runId: number; leadId: number }
  | { kind: 'skipped' | 'limit' | 'busy' | 'no_leads' | 'no_audio' | 'closed' | 'conflict' };

/**
 * Os números da campanha: os escolhidos, ou TODOS os cadastrados (`all_numbers`, a campanha automática), lidos agora. Número
 * novo entra sozinho no rodízio; número excluído some sozinho.
 */
export async function campaignInstanceIds(
  db: Db,
  campaign: Pick<AutomationCampaign, 'instance_ids' | 'all_numbers'>,
): Promise<number[]> {
  if (!campaign.all_numbers) return campaign.instance_ids;
  const rows = await db.selectFrom('wa_instances').select('id').orderBy('id').execute();
  return rows.map((r) => r.id);
}

/** Há pelo menos um áudio ativo (e com arquivo) na biblioteca? */
export async function hasActiveAudio(db: Db): Promise<boolean> {
  const row = await db
    .selectFrom('wa_audios')
    .select('id')
    .where('active', '=', true)
    .where('media_path', '<>', '')
    .limit(1)
    .executeTakeFirst();
  return !!row;
}

/**
 * Reserva o próximo lead para um número, numa transação. Tudo aqui é seguro contra concorrência: a trava do
 * número serializa contagem + inserção; a campanha é lida com FOR SHARE (pausar ou encerrar espera a reserva
 * em andamento); o lead é escolhido com FOR UPDATE SKIP LOCKED; os índices únicos barram o mesmo lead duas vezes.
 */
export async function reserveNext(
  db: Db,
  campaignId: number,
  instanceId: number,
  now: Date,
): Promise<Reservation> {
  return db.transaction().execute(async (trx): Promise<Reservation> => {
    await sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${instanceId})`.execute(trx);

    const campaign = await trx
      .selectFrom('automation_campaigns')
      .selectAll()
      .where('id', '=', campaignId)
      .forShare()
      .executeTakeFirst();
    if (campaign?.status !== 'active' || (campaign.list_id === null && !campaign.all_lists)) {
      return { kind: 'skipped' };
    }
    if (!campaign.all_numbers && !campaign.instance_ids.includes(instanceId)) return { kind: 'skipped' };
    const automation = await trx
      .selectFrom('automations')
      .select('status')
      .where('id', '=', campaign.automation_id)
      .executeTakeFirst();
    if (automation?.status !== 'active') return { kind: 'skipped' };
    // Número desconectado ou excluído não recebe lead novo.
    const instance = await trx
      .selectFrom('wa_instances')
      .select(['id', 'status'])
      .where('id', '=', instanceId)
      .executeTakeFirst();
    if (instance?.status !== 'open') return { kind: 'skipped' };

    // Agenda: dia não permitido ou antes da data inicial = nada é reservado; passou da data final = a campanha termina.
    const today = spDate(now);
    const schedule = scheduleOf(campaign);
    if (schedule.endDate && today > schedule.endDate) return { kind: 'closed' };
    if (schedule.startDate && today < schedule.startDate) return { kind: 'closed' };
    if (!dayAllowed(today, schedule)) return { kind: 'closed' };

    // Cota do dia (contatos EFETIVOS, manual + automático): número cheio não recebe lead novo. Isto é leitura; a vaga
    // de verdade é segurada no envio.
    const limit = effectiveLimit(campaign.daily_limit);
    const usage = (await instanceUsage(trx, [instanceId], today, limit)).get(instanceId);
    if (usage?.limitReached) return { kind: 'limit' };
    const used = usage?.total ?? 0;

    // No máximo UM lead esperando a primeira mensagem por número: a fila fica curta e o espaçamento fica justo.
    const waiting = await trx
      .selectFrom('automation_runs')
      .select('id')
      .where('campaign_id', '=', campaign.id)
      .where('instance_id', '=', instanceId)
      .where('status', 'in', ['pending', 'running'])
      .where('current_step', '=', 1)
      .limit(1)
      .executeTakeFirst();
    if (waiting) return { kind: 'busy' };

    const first = await trx
      .selectFrom('automation_steps')
      .select(['delay_seconds', 'action_type', 'audio_mode'])
      .where('automation_id', '=', campaign.automation_id)
      .where('position', '=', 1)
      .executeTakeFirst();
    if (!first) return { kind: 'skipped' };
    // Etapa que sorteia áudio sem nenhum áudio ativo: não reserva ninguém. Reservar agora só faria a etapa falhar e o
    // lead sair da campanha sem ter recebido nada.
    if (first.action_type === 'send_audio' && first.audio_mode === 'random' && !(await hasActiveAudio(trx))) {
      return { kind: 'no_audio' };
    }

    // Quem entra vem do público da campanha (lista, filtros, bloqueio, cooldown, participação): uma regra só.
    const audience = audienceConfigOf(campaign);
    if (!audience) return { kind: 'skipped' };
    const [leadId] = await getCampaignEligibleLeads(trx, audience, now, { limit: 1, lock: true });
    if (leadId === undefined) return { kind: 'no_leads' };
    if (!(await leadFreeOfOtherCampaign(trx, campaign.automation_id, leadId))) return { kind: 'conflict' };

    const slot = planSlot(now, {
      startMin: campaign.window_start_min,
      endMin: campaign.window_end_min,
      limit,
      used,
    });
    if (!slot) return { kind: 'closed' };

    const created = await sql<{ id: number }>`
      INSERT INTO automation_runs
        (automation_id, lead_id, instance_id, started_by, campaign_id, slot_date, status, current_step, started_at, next_run_at)
      VALUES (${campaign.automation_id}, ${leadId}, ${instanceId}, ${campaign.started_by}, ${campaign.id},
        ${today}::date, 'pending', 1, ${now}, ${scheduleAfter(slot, first.delay_seconds)})
      ON CONFLICT DO NOTHING
      RETURNING id`.execute(trx);
    const runId = created.rows[0]?.id;
    if (runId === undefined) return { kind: 'conflict' };

    await audit(trx, {
      userId: campaign.started_by,
      action: 'lead_adicionado_campanha',
      entity: 'automacao',
      entityId: campaign.automation_id,
      details: { campanha: campaign.id, execucao: runId, lead: leadId, numero: instanceId },
    });
    return { kind: 'reserved', runId, leadId };
  });
}

/**
 * A ordem em que os números recebem lead novo: do MENOS usado ao mais usado (uso do dia dividido pelo limite) e,
 * entre números com o mesmo uso, por sorteio. Assim o trabalho se reparte por igual sem favorecer o primeiro da lista.
 */
export function orderByUtilization(
  instanceIds: readonly number[],
  usage: ReadonlyMap<number, number>,
  dailyLimit: number,
  shuffle: (ids: readonly number[]) => number[] = shuffled,
): number[] {
  const load = (id: number) => (usage.get(id) ?? 0) / dailyLimit;
  // Embaralha antes: a ordenação é estável, então o embaralhamento decide só os empates.
  return shuffle(instanceIds).sort((a, b) => load(a) - load(b));
}

export interface TickResult {
  reserved: number;
  finished: number;
  /** Campanhas que reservaram leads ou terminaram neste ciclo (para avisar as telas em tempo real). */
  campaignIds: number[];
}

/**
 * Um ciclo das campanhas: para cada campanha ativa (de automação ativa), reserva leads para os números que
 * precisam, do menos usado ao mais usado (empate: sorteio), até `maxReservations` no ciclo. Encerra sozinha a
 * campanha cuja lista acabou (a automática, de todas as listas, nunca termina sozinha). Sem Evolution configurada não
 * faz nada.
 */
export async function advanceCampaigns(
  db: Db,
  options: { now?: Date; maxReservations?: number } = {},
): Promise<TickResult> {
  const result: TickResult = { reserved: 0, finished: 0, campaignIds: [] };
  if (!isEvolutionConfigured()) return result;
  const now = options.now ?? new Date();
  const max = options.maxReservations ?? MAX_RESERVATIONS_PER_CYCLE;

  const campaigns = await db
    .selectFrom('automation_campaigns as c')
    .innerJoin('automations as a', 'a.id', 'c.automation_id')
    .selectAll('c')
    .where('c.status', '=', 'active')
    .where('a.status', '=', 'active')
    .orderBy('c.id')
    .limit(50)
    .execute();

  for (const campaign of campaigns) {
    if (result.reserved >= max) break;
    try {
      const done = await advanceOne(db, campaign, now, max - result.reserved);
      result.reserved += done.reserved;
      result.finished += done.finished;
      if (done.reserved || done.finished) result.campaignIds.push(campaign.id);
    } catch (error) {
      // Uma campanha com problema não trava as outras: o erro é registrado e o próximo ciclo tenta de novo.
      console.error(`[campanha] ${campaign.id}:`, (error as Error).message);
    }
  }
  return result;
}

async function advanceOne(
  db: Db,
  campaign: AutomationCampaign,
  now: Date,
  room: number,
): Promise<TickResult> {
  const result: TickResult = { reserved: 0, finished: 0, campaignIds: [] };
  // Campanha de UMA lista: lista excluída ou arquivada encerra. A de todas as listas (automática) não depende de nenhuma.
  if (!campaign.all_lists) {
    if (campaign.list_id === null) {
      if (await endCampaign(db, campaign.id, 'stopped', REASON.listRemoved)) result.finished += 1;
      return result;
    }
    const list = await db
      .selectFrom('lists')
      .select('archived_at')
      .where('id', '=', campaign.list_id)
      .executeTakeFirst();
    if (list?.archived_at) {
      if (await endCampaign(db, campaign.id, 'stopped', REASON.listArchived)) result.finished += 1;
      return result;
    }
  }
  // Agenda. Antes da data inicial: agendada, nada é reservado. Depois da data final: termina (o que já foi enviado fica).
  const today = spDate(now);
  const schedule = scheduleOf(campaign);
  if (schedule.endDate && today > schedule.endDate) {
    if (await endCampaign(db, campaign.id, 'finished', REASON.endDate)) result.finished += 1;
    return result;
  }
  if (schedule.startDate && today < schedule.startDate) return result;
  // Dia da semana não permitido: nenhum contato novo neste dia.
  if (!dayAllowed(today, schedule)) return result;
  // A janela de hoje já fechou: espera o próximo dia permitido (antes de abrir, reserva: o horário sai na abertura).
  if (spTime(now).minutes >= campaign.window_end_min) return result;

  // O rodízio só considera os números com vaga hoje (o cheio sai do pool até o dia seguinte).
  const limit = effectiveLimit(campaign.daily_limit);
  const instanceIds = await campaignInstanceIds(db, campaign);
  const usage = await instanceUsage(db, instanceIds, today, limit);
  const totals = new Map([...usage].map(([id, u]) => [id, u.total] as const));
  for (const instanceId of orderByUtilization(poolWithCapacity(instanceIds, usage, limit), totals, limit)) {
    if (result.reserved >= room) break;
    const reservation = await reserveNext(db, campaign.id, instanceId, now);
    if (reservation.kind === 'reserved') result.reserved += 1;
    if (reservation.kind === 'no_audio') break;
    if (reservation.kind === 'no_leads') {
      // A campanha automática (todas as listas) nunca termina sozinha: leads novos chegam a cada importação.
      if (!campaign.all_lists && (await finishIfExhausted(db, campaign, now))) result.finished += 1;
      break;
    }
  }
  return result;
}

/** A lista acabou e ninguém está esperando (nem para o próximo passo)? Então a campanha termina. */
async function finishIfExhausted(db: Db, campaign: AutomationCampaign, now: Date): Promise<boolean> {
  if (campaign.list_id === null) return false;
  const audience = audienceConfigOf(campaign);
  if (!audience) return false;
  // Ainda há alguém a quem esta campanha pode escrever? (só estavam ocupados neste instante)
  if ((await getCampaignEligibleLeads(db, audience, now, { limit: 1 })).length) return false;
  const live = await db
    .selectFrom('automation_runs')
    .select('id')
    .where('campaign_id', '=', campaign.id)
    .where('status', 'in', ['pending', 'running'])
    .limit(1)
    .executeTakeFirst();
  if (live) return false;
  return endCampaign(db, campaign.id, 'finished', REASON.listExhausted);
}

/**
 * Encerra a campanha (só se ainda estiver ativa ou pausada) e registra o motivo. Ao ENCERRAR (`stopped`), as
 * participações que ainda não terminaram são canceladas (inclusive as etapas seguintes de quem já recebeu a
 * primeira mensagem); o histórico do que já foi enviado fica. Termina por `finished` quando a lista acabou.
 * Devolve false se ela já estava encerrada (chamar duas vezes não faz nada na segunda).
 */
export async function endCampaign(
  db: Db,
  campaignId: number,
  status: 'stopped' | 'finished',
  reason: string,
  userId: string | null = null,
  ip: string | null = null,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const ended = await trx
      .updateTable('automation_campaigns')
      .set({ status, ended_at: sql`now()`, end_reason: reason, updated_at: sql`now()` })
      .where('id', '=', campaignId)
      .where('status', 'in', ['active', 'paused'])
      .returning(['id', 'automation_id'])
      .executeTakeFirst();
    if (!ended) return false;
    let cancelled = 0;
    if (status === 'stopped') {
      const rows = await cancelLiveRuns(trx, { campaignId }, REASON.campaignStopped);
      await auditCancelled(trx, rows, REASON.campaignStopped, { userId, ip });
      cancelled = rows.length;
    } else if (reason === REASON.endDate) {
      // Chegou a data final: nenhum PRIMEIRO contato novo sai. Quem já recebeu o primeiro segue com as etapas seguintes.
      const rows = await cancelLiveRuns(trx, { campaignId, firstContactOnly: true }, REASON.endDate);
      await auditCancelled(trx, rows, REASON.endDate, { userId, ip });
      cancelled = rows.length;
    }
    await audit(trx, {
      userId,
      action: 'encerrou_campanha',
      entity: 'automacao',
      entityId: ended.automation_id,
      details: { campanha: campaignId, motivo: reason, execucoes_canceladas: cancelled },
      ip,
    });
    return true;
  });
}

/**
 * Arquivar a automação encerra as campanhas vivas dela. Roda dentro da transação de quem arquivou; as
 * participações em andamento já foram canceladas por ela (`cancelLiveRuns` por automação).
 */
export async function endCampaignsOfAutomation(
  trx: Db,
  automationId: number,
  reason: string,
  userId: string | null,
  ip: string | null,
): Promise<number> {
  const ended = await trx
    .updateTable('automation_campaigns')
    .set({ status: 'stopped', ended_at: sql`now()`, end_reason: reason, updated_at: sql`now()` })
    .where('automation_id', '=', automationId)
    .where('status', 'in', ['active', 'paused'])
    .returning('id')
    .execute();
  for (const c of ended) {
    await audit(trx, {
      userId,
      action: 'encerrou_campanha',
      entity: 'automacao',
      entityId: automationId,
      details: { campanha: c.id, motivo: reason },
      ip,
    });
  }
  return ended.length;
}
