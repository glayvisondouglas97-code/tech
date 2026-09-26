/**
 * Executor das automações: a cada ciclo do job (`jobs/scheduler.ts`) procura participações vencidas
 * (`automation_runs.next_run_at <= now()`) e executa UMA etapa de cada, na ordem, sem paralelismo.
 *
 * Como evita mensagem duplicada (nada depende da memória do Node):
 * 1. CLAIM ATÔMICO: `pending → running` num único UPDATE com `FOR UPDATE SKIP LOCKED`. Dois workers (ou dois
 *    processos) nunca pegam a mesma participação. Cada worker segura uma por vez.
 * 2. UMA TENTATIVA LÓGICA POR ETAPA: o índice único (automation_run_id, step_id) de `automation_step_runs`.
 *    A tentativa é gravada como "running" (commit) ANTES de chamar a Evolution.
 * 3. NUNCA REENVIA NO ESCURO: se o processo cair depois de a tentativa começar, ela fica "running" e a
 *    recuperação a marca como falha `executor_interrompido`. Erro/timeout sem resposta da Evolution também
 *    vira falha (`resultado_incerto`): não há idempotência na Evolution, então reenviar poderia duplicar.
 *    Só se tenta de novo quando se SABE que a mensagem não saiu (número desconectado antes do envio),
 *    no máximo `MAX_ATTEMPTS` vezes, com espera de `RETRY_SECONDS`.
 *
 * Antes de cada envio confere: automação ativa, participação válida, etapa válida, lead existente e elegível
 * (não bloqueado, não anonimizado), número existente e conectado, lead que não respondeu e condições.
 *
 * Não faz retry cego, não tem timer por lead nem por etapa, e não contorna limites do WhatsApp: o lote por
 * ciclo (`BATCH_SIZE`) existe para dar vazão controlada.
 */
import { access } from 'node:fs/promises';
import { sql } from 'kysely';
import { stepProblem } from '../../../shared/automations';
import { usageOf } from '../../../shared/quota';
import type { Db } from '../../db';
import type {
  AutomationCampaign,
  AutomationRun,
  AutomationStep as AutomationStepRow,
  AutomationStepRun,
  WaInstance,
} from '../../db/schema';
import { audit } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import { addEvents } from '../../lib/events';
import { displayPhone } from '../imports/phone';
import { type AudioPick, pickAudioIn, readAudioBytes } from '../whatsapp/audios';
import { EvolutionError, evolution, isEvolutionConfigured } from '../whatsapp/evolution';
import { mediaPathOf } from '../whatsapp/media';
import { sendAndStore } from '../whatsapp/messaging';
import { contactJidsOf, type WaMessage as RawMessage } from '../whatsapp/parse';
import { enqueue } from '../whatsapp/queue';
import {
  auditContactLimit,
  checkInstanceDailyQuota,
  claimContactQuota,
  confirmContactQuota,
  effectiveLimit,
  instanceUsage,
  notifyUsageChanged,
  poolWithCapacity,
  type QuotaClaim,
  quotaDate,
  releaseContactQuota,
} from '../whatsapp/quota';
import { openLeadConversation } from '../whatsapp/store';
import { evaluateConditions, type LeadFacts } from './conditions';
import { type LeadForRun, leadEligibility } from './eligibility';
import { orderByUtilization } from './queue';
import { type RenderData, renderMessage } from './renderer';
import { cancelOrphanedRuns, REASON, recoverStuckRuns } from './runs';
import { BATCH_SIZE, MAX_ATTEMPTS, RETRY_SECONDS, scheduleAfter } from './schedule';
import {
  addDays,
  followUpSchedule,
  insideSchedule,
  isoWeekday,
  nextScheduleOpening,
  scheduleOf,
  spInstant,
  spTime,
} from './window';

type Tx = Db;

export interface CycleResult {
  claimed: number;
  sent: number;
  skipped: number;
  cancelled: number;
  failed: number;
  completed: number;
  rescheduled: number;
  /** Campanhas cujas participações foram atendidas neste ciclo (para avisar as telas em tempo real). */
  campaignIds: number[];
}

const emptyResult = (): CycleResult => ({
  claimed: 0,
  sent: 0,
  skipped: 0,
  cancelled: 0,
  failed: 0,
  completed: 0,
  rescheduled: 0,
  campaignIds: [],
});

/** O que aconteceu com uma participação neste ciclo. */
interface Outcome {
  kind: 'sent' | 'skipped' | 'cancelled' | 'failed' | 'rescheduled' | 'released' | 'gone' | 'noop';
  /** A participação terminou (última etapa enviada ou pulada). */
  completed?: boolean;
}

type Message =
  | { kind: 'text'; text: string }
  | { kind: 'audio'; audio: { id: number; label: string; path: string; mime: string } };

/** Tudo o que o envio precisa, decidido dentro da transação (com a participação travada). */
interface SendContext {
  run: AutomationRun;
  step: AutomationStepRow;
  stepRun: { id: number; attempts: number };
  lead: LeadForRun;
  instance: WaInstance;
  conversation: { id: number } | null;
  message: Message;
  /** Vaga da cota diária segurada para este envio (contato novo de campanha); vazio nas etapas que não são contato novo. */
  claim: QuotaClaim | null;
  campaign: AutomationCampaign | null;
}

type Delivery =
  | { ok: true; messageId: number | null; warning?: string }
  /** `notSent`: a mensagem SABIDAMENTE não saiu (a vaga da cota pode voltar). Na dúvida, é falso e a vaga fica ocupada. */
  | { ok: false; retry: boolean; notSent: boolean; code: string; error: string };

// ---------- ciclo ----------

/**
 * Um ciclo do job: recupera participações abandonadas, cancela as que nunca mais poderão enviar e atende até
 * `batchSize` participações vencidas, uma de cada vez. Sem Evolution configurada não faz nada.
 */
export async function runAutomationCycle(
  db: Db,
  options: { batchSize?: number; now?: Date } = {},
): Promise<CycleResult> {
  const result = emptyResult();
  // O "agora" só é trocado nos testes (para atravessar o dia sem esperar); no servidor é o relógio de verdade.
  const now = options.now ?? new Date();
  if (!isEvolutionConfigured()) return result;
  await recoverStuckRuns(db);
  await cancelOrphanedRuns(db);
  const batch = options.batchSize ?? BATCH_SIZE;
  for (let i = 0; i < batch; i++) {
    const run = await claimNextRun(db, now);
    if (!run) break;
    result.claimed += 1;
    if (run.campaign_id !== null && !result.campaignIds.includes(run.campaign_id)) {
      result.campaignIds.push(run.campaign_id);
    }
    const outcome = await processRun(db, run, now);
    switch (outcome.kind) {
      case 'sent':
        result.sent += 1;
        break;
      case 'skipped':
        result.skipped += 1;
        break;
      case 'cancelled':
        result.cancelled += 1;
        break;
      case 'failed':
        result.failed += 1;
        break;
      case 'rescheduled':
        result.rescheduled += 1;
        break;
    }
    if (outcome.completed) result.completed += 1;
  }
  return result;
}

/**
 * Pega a próxima participação vencida e a marca "running" no mesmo comando (atômico: outro worker que chegar
 * junto pula a linha travada e não a pega). Só entram automações ATIVAS (pausada espera, sem mudar nada) e
 * números CONECTADOS (desconectado espera sozinho, sem gastar o lote nem chamar a Evolution).
 */
async function claimNextRun(db: Db, now: Date): Promise<AutomationRun | null> {
  // Participação de campanha só sai com a campanha ATIVA e dentro da AGENDA (São Paulo): janela de horário, dia da
  // semana permitido e, para o PRIMEIRO contato, entre a data inicial e a final. As etapas seguintes de quem já foi
  // contatado seguem o horário e os dias, e continuam mesmo depois da data final.
  const t = spTime(now);
  const minutes = t.minutes;
  const weekday = isoWeekday(t.date);
  const claimed = await sql<AutomationRun>`
    WITH due AS (
      SELECT r.id
      FROM automation_runs r
      JOIN automations a ON a.id = r.automation_id AND a.status = 'active'
      JOIN wa_instances i ON i.id = r.instance_id AND i.status = 'open'
      LEFT JOIN automation_campaigns c ON c.id = r.campaign_id
      WHERE r.status = 'pending' AND r.next_run_at <= ${now}
        AND (r.campaign_id IS NULL
             OR (c.status IN ('active', 'finished')
                 AND ${minutes} >= c.window_start_min AND ${minutes} < c.window_end_min
                 AND ${weekday}::smallint = ANY(c.days_of_week)
                 AND (r.current_step > 1
                      OR (c.status = 'active' AND ${t.date}::date >= c.start_date
                          AND (c.end_date IS NULL OR ${t.date}::date <= c.end_date)))))
      ORDER BY r.next_run_at, r.id
      LIMIT 1
      FOR UPDATE OF r SKIP LOCKED
    )
    UPDATE automation_runs r SET status = 'running', updated_at = now()
    FROM due WHERE r.id = due.id
    RETURNING r.*`.execute(db);
  return claimed.rows[0] ?? null;
}

async function processRun(db: Db, claimed: AutomationRun, now: Date): Promise<Outcome> {
  let stage: 'decidir' | 'enviar' | 'gravar' = 'decidir';
  let context: SendContext | null = null;
  try {
    const decision = await db.transaction().execute((tx) => decide(tx, claimed, now));
    if (decision.kind === 'ended') return decision.outcome;
    context = decision.context;
    stage = 'enviar';
    const delivery = await deliver(db, context);
    stage = 'gravar';
    const ctx = context;
    const outcome = await db.transaction().execute((tx) => finalize(tx, ctx, delivery, now));
    if (ctx.claim) notifyUsageChanged(ctx.claim.instanceId);
    return outcome;
  } catch (error) {
    if (error instanceof QuotaRace && stage === 'decidir') {
      // A decisão foi desfeita (nada foi gravado nem enviado): a participação volta a esperar por alguns segundos.
      await db
        .transaction()
        .execute((tx) => postponeRun(tx, claimed, scheduleAfter(now, QUOTA_RACE_RETRY_SECONDS)))
        .catch(() => {});
      return { kind: 'released' };
    }
    console.error(`[automação] participação ${claimed.id} (${stage}):`, (error as Error).message);
    if (stage === 'decidir') {
      // Nada foi enviado: encerra com falha em vez de repetir o erro a cada ciclo.
      await db
        .transaction()
        .execute((tx) =>
          finishRun(tx, claimed, 'failed', 'erro_interno', {
            audit: {
              action: 'falhou_execucao_automacao',
              details: { erro: (error as Error).message.slice(0, 200) },
            },
          }),
        )
        .catch(() => {});
      return { kind: 'failed' };
    }
    // Se caiu ao gravar o resultado, a tentativa fica "running" e a recuperação a resolve sem reenviar.
    return { kind: 'failed' };
  }
}

// ---------- fase 1: decidir (dentro da transação, com a participação travada) ----------

type Decision = { kind: 'ended'; outcome: Outcome } | { kind: 'send'; context: SendContext };

/**
 * Outro envio pegou a última vaga do número no mesmo instante. Lançar isto desfaz a transação inteira da decisão (o áudio
 * sorteado volta para o saco) e `processRun` só devolve a participação à fila para daqui a pouco.
 */
class QuotaRace extends Error {}

/** Espera antes de reavaliar uma participação que perdeu a corrida pela última vaga. */
const QUOTA_RACE_RETRY_SECONDS = 30;

async function decide(tx: Tx, claimed: AutomationRun, now: Date): Promise<Decision> {
  const ended = (outcome: Outcome): Decision => ({ kind: 'ended', outcome });

  // Ainda é nossa? (uma resposta do lead pode ter cancelado entre o claim e agora)
  const run = await tx
    .selectFrom('automation_runs')
    .selectAll()
    .where('id', '=', claimed.id)
    .forUpdate()
    .executeTakeFirst();
  if (run?.status !== 'running') return ended({ kind: 'gone' });

  const automation = await tx
    .selectFrom('automations')
    .select(['id', 'status', 'trigger_type'])
    .where('id', '=', run.automation_id)
    .executeTakeFirst();
  if (!automation) return ended({ kind: 'gone' });
  if (automation.status === 'archived') return ended(await cancelRun(tx, run, REASON.archived));
  if (automation.status !== 'active') return ended(await releaseRun(tx, run));

  // Campanha: encerrada cancela; pausada espera; fora da janela de horário espera a janela abrir.
  let campaign: AutomationCampaign | undefined;
  if (run.campaign_id !== null) {
    campaign = await tx
      .selectFrom('automation_campaigns')
      .selectAll()
      .where('id', '=', run.campaign_id)
      .executeTakeFirst();
    if (campaign) {
      if (campaign.status === 'stopped') return ended(await cancelRun(tx, run, REASON.campaignStopped));
      if (campaign.status === 'paused') return ended(await releaseRun(tx, run));
      // Fora da agenda (horário, dia da semana ou datas): espera a próxima abertura válida. Depois da data final, o
      // primeiro contato que ainda não saiu é cancelado (`data_final`); as etapas seguintes continuam.
      const schedule = run.current_step > 1 ? followUpSchedule(scheduleOf(campaign)) : scheduleOf(campaign);
      if (!insideSchedule(now, schedule)) {
        const opening = nextScheduleOpening(now, schedule);
        return ended(
          opening ? await postponeRun(tx, run, opening) : await cancelRun(tx, run, REASON.endDate),
        );
      }
    }
  }

  if (run.instance_id === null) return ended(await cancelRun(tx, run, REASON.noNumber));
  const instance = await tx
    .selectFrom('wa_instances')
    .selectAll()
    .where('id', '=', run.instance_id)
    .executeTakeFirst();
  if (!instance) return ended(await cancelRun(tx, run, REASON.noNumber));
  if (instance.status !== 'open') return ended(await reschedule(tx, run, now));

  const step = await tx
    .selectFrom('automation_steps')
    .selectAll()
    .where('automation_id', '=', run.automation_id)
    .where('position', '=', run.current_step)
    .executeTakeFirst();
  if (!step) return ended(await completeRun(tx, run));

  // Já existe tentativa desta etapa? (a participação pode ter sido interrompida antes de avançar)
  const existing = await tx
    .selectFrom('automation_step_runs')
    .selectAll()
    .where('automation_run_id', '=', run.id)
    .where('step_id', '=', step.id)
    .forUpdate()
    .executeTakeFirst();
  if (existing) {
    const resolved = await resolveExisting(tx, run, step, existing, now);
    if (resolved) return ended(resolved);
  }

  const eligibility = await leadEligibility(tx, run.lead_id);
  if ('reason' in eligibility) return ended(await cancelRun(tx, run, eligibility.reason));
  const lead = eligibility.lead;
  // Campanha: o lead só recebe o PRIMEIRO envio se ainda estiver na fila livre. Se um atendente o pegou ou
  // chamou no meio do caminho, a campanha sai da frente (a vaga do número volta).
  if (
    run.campaign_id !== null &&
    run.current_step === 1 &&
    (lead.status !== 'pendente' || lead.assigned_to !== null)
  ) {
    return ended(await cancelRun(tx, run, REASON.leadTaken));
  }

  const problem = stepProblem({
    actionType: step.action_type,
    messageText: step.message_text,
    audioId: step.audio_id,
    audioMode: step.audio_mode,
  });
  if (problem)
    return ended(await failStep(tx, run, step, existing, 'etapa_invalida', `Etapa incompleta: ${problem}`));

  // Contato NOVO de campanha (etapa 1): o número precisa ter vaga na cota do DIA EM QUE O ENVIO ACONTECE, somando os
  // contatos manuais e automáticos (ver whatsapp/quota.ts). Janela e cota são regras independentes: as duas precisam valer.
  // Reserva não é contato: o lead reservado ontem para hoje consome a cota de hoje, e só quando for realmente enviado.
  // Também é contato novo a execução manual pela API (`/run`, gatilho "manual"): passa pela MESMA cota, sem exceção.
  // O gatilho "lead chamado" não: o contato já foi contado pelo Chamar e a etapa 1 dela é acompanhamento.
  const contact =
    run.current_step === 1 &&
    (campaign !== undefined || (run.campaign_id === null && automation.trigger_type === 'manual'));
  const limit = effectiveLimit(campaign?.daily_limit);
  const today = quotaDate(now);
  if (contact && !(await checkInstanceDailyQuota(tx, instance.id, today, limit)).ok) {
    return ended(await noCapacity(tx, run, campaign ?? null, instance, now));
  }

  // A conversa deste lead NESTE número (nunca "qualquer conversa do lead").
  const conversations = await tx
    .selectFrom('wa_conversations as c')
    .select(['c.id', 'c.lead_replied'])
    .where('c.instance_id', '=', instance.id)
    .where('c.lead_id', '=', lead.id)
    .execute();
  if (conversations.length > 1) {
    return ended(
      await failStep(
        tx,
        run,
        step,
        existing,
        'conversa_ambigua',
        'Há mais de uma conversa deste lead neste número.',
      ),
    );
  }
  const conversation = conversations[0] ?? null;

  // O lead respondeu depois que a participação começou? (o webhook já cancela na hora; isto é a rede de segurança)
  if (conversation) {
    const reply = await tx
      .selectFrom('wa_messages')
      .select('id')
      .where('conversation_id', '=', conversation.id)
      .where('from_me', '=', false)
      .where('sent_at', '>=', run.started_at ?? run.created_at)
      .limit(1)
      .executeTakeFirst();
    if (reply) return ended(await cancelRun(tx, run, REASON.replied));
  }

  // Condições (todas precisam valer). Não atendida: pula a etapa, sem enviar, e segue para a próxima.
  const facts: LeadFacts = {
    result: lead.result,
    replied: conversation?.lead_replied ?? false,
    status: lead.status,
    listId: lead.list_id,
  };
  const listIds = step.conditions.flatMap((c) => (c.field === 'lead_list' ? [c.value] : []));
  const lists = listIds.length
    ? await tx.selectFrom('lists').select(['id', 'name']).where('id', 'in', listIds).execute()
    : [];
  const check = evaluateConditions(step.conditions, facts, (id) => lists.find((l) => l.id === id)?.name);
  if (!check.passed) {
    await recordSkipped(tx, run, step, existing, `Pulada: condição não atendida (${check.failed})`, now);
    return ended(await advanceRun(tx, run, now, { kind: 'skipped' }));
  }

  // A mensagem: texto com as variáveis trocadas, ou o áudio da biblioteca.
  let message: Message;
  if (step.action_type === 'send_text') {
    const rendered = renderMessage(step.message_text ?? '', await renderData(tx, run, lead, instance));
    if (rendered.unknown.length) {
      const names = rendered.unknown.map((n) => `{{${n}}}`).join(', ');
      return ended(
        await failStep(
          tx,
          run,
          step,
          existing,
          'variavel_desconhecida',
          `Variável que não existe: ${names}.`,
        ),
      );
    }
    message = { kind: 'text', text: rendered.text };
  } else {
    const pick = await chooseAudio(tx, run, step, existing);
    if (typeof pick === 'string')
      return ended(await failStep(tx, run, step, existing, 'audio_indisponivel', pick));
    message = { kind: 'audio', audio: pick };
  }

  // O áudio escolhido (fixo ou sorteado) fica gravado na tentativa, junto com o nome dele.
  const chosen = message.kind === 'audio' ? message.audio : null;

  // A vaga da cota é segurada AQUI, de forma atômica, junto com a gravação da tentativa (mesma transação) e ANTES da
  // Evolution. Fica como "incerta" até o resultado: confirmada se o envio foi aceito, devolvida só se sabidamente não saiu.
  let claim: QuotaClaim | null = null;
  if (contact) {
    claim = await claimContactQuota(tx, instance.id, today, limit);
    if (!claim) throw new QuotaRace();
  }

  // A tentativa passa a existir (e é gravada) ANTES de qualquer chamada à Evolution.
  let stepRun: { id: number; attempts: number };
  if (existing) {
    const attempts = existing.attempts + 1;
    await tx
      .updateTable('automation_step_runs')
      .set({
        status: 'running',
        attempts,
        started_at: sql`now()`,
        audio_id: chosen?.id ?? null,
        audio_label: chosen?.label ?? null,
        updated_at: sql`now()`,
      })
      .where('id', '=', existing.id)
      .execute();
    stepRun = { id: existing.id, attempts };
  } else {
    const created = await tx
      .insertInto('automation_step_runs')
      .values({
        automation_run_id: run.id,
        step_id: step.id,
        status: 'running',
        scheduled_at: run.next_run_at ?? now,
        started_at: now,
        attempts: 1,
        audio_id: chosen?.id ?? null,
        audio_label: chosen?.label ?? null,
      })
      .returning(['id', 'attempts'])
      .executeTakeFirstOrThrow();
    stepRun = created;
  }
  await tx.updateTable('automation_runs').set({ updated_at: sql`now()` }).where('id', '=', run.id).execute();
  return {
    kind: 'send',
    context: { run, step, stepRun, lead, instance, conversation, message, claim, campaign: campaign ?? null },
  };
}

/**
 * O áudio desta tentativa. Modo fixo: o áudio da etapa. Modo sorteio: o do rodízio persistente (`wa_audio_bags`),
 * sorteado AQUI, dentro da mesma transação que grava a tentativa, para nunca ser sorteado de novo na hora de
 * enviar. Uma tentativa anterior que NÃO saiu (número desconectado) reaproveita o áudio já sorteado, se ele
 * ainda estiver ativo. Devolve o texto do problema se não houver áudio utilizável.
 */
async function chooseAudio(
  tx: Tx,
  run: AutomationRun,
  step: AutomationStepRow,
  existing: AutomationStepRun | undefined,
): Promise<AudioPick | string> {
  const load = (id: number, onlyActive: boolean) => {
    let q = tx
      .selectFrom('wa_audios')
      .select(['id', 'label', 'media_path', 'media_mime'])
      .where('id', '=', id);
    if (onlyActive) q = q.where('active', '=', true);
    return q.executeTakeFirst();
  };
  let audio: AudioPick | null = null;
  const asPick = (row: { id: number; label: string; media_path: string; media_mime: string }): AudioPick => ({
    id: row.id,
    label: row.label,
    path: mediaPathOf(row.media_path),
    mime: row.media_mime,
  });
  if (step.audio_mode === 'random') {
    if (existing?.audio_id) {
      const kept = await load(existing.audio_id, true);
      if (kept?.media_path) audio = asPick(kept);
    }
    audio ??= await pickAudioIn(
      tx,
      run.campaign_id ? `campaign:${run.campaign_id}` : `automation:${run.automation_id}`,
    );
    if (!audio) return 'Não há nenhum áudio ativo na biblioteca para sortear.';
  } else {
    const row = step.audio_id ? await load(step.audio_id, false) : undefined;
    if (!row?.media_path) return 'O áudio da etapa não existe mais na biblioteca.';
    audio = asPick(row);
  }
  const exists = await access(audio.path).then(
    () => true,
    () => false,
  );
  return exists ? audio : 'O arquivo do áudio não foi encontrado.';
}

/**
 * O número desta participação está sem vaga hoje (cota cheia). Como a MENSAGEM AINDA NÃO SAIU (é a etapa 1 e não há
 * tentativa que possa ter saído), é seguro escolher outro número da campanha que esteja conectado e com vaga (o de menor
 * uso relativo). Se nenhum tiver, espera a abertura da janela do dia seguinte: hoje não sai mais nada, e amanhã o
 * contato conta na cota de amanhã.
 */
async function noCapacity(
  tx: Tx,
  run: AutomationRun,
  campaign: AutomationCampaign | null,
  instance: WaInstance,
  now: Date,
): Promise<Outcome> {
  const today = quotaDate(now);
  const limit = effectiveLimit(campaign?.daily_limit);
  const others = campaign ? campaign.instance_ids.filter((id) => id !== instance.id) : [];
  if (campaign && others.length) {
    const open = (
      await tx
        .selectFrom('wa_instances')
        .select('id')
        .where('id', 'in', others)
        .where('status', '=', 'open')
        .execute()
    ).map((row) => row.id);
    const usage = await instanceUsage(tx, open, today, limit);
    const totals = new Map([...usage].map(([id, u]) => [id, u.total] as const));
    const [next] = orderByUtilization(poolWithCapacity(open, usage, limit), totals, limit);
    if (next !== undefined) {
      await tx
        .updateTable('automation_runs')
        .set({ instance_id: next, updated_at: sql`now()` })
        .where('id', '=', run.id)
        .where('status', '=', 'running')
        .execute();
      await audit(tx, {
        userId: null,
        action: 'numero_trocado_campanha',
        entity: 'automacao',
        entityId: run.automation_id,
        details: {
          campanha: campaign.id,
          execucao: run.id,
          de: instance.id,
          para: next,
          motivo: 'limite_diario',
        },
      });
      return releaseRun(tx, run);
    }
  }
  const { usage } = await checkInstanceDailyQuota(tx, instance.id, today, limit);
  await auditContactLimit(tx, {
    instanceId: instance.id,
    usage,
    origin: campaign ? 'campanha' : 'api',
    situation: 'recusado',
    campaignId: campaign?.id ?? null,
  });
  // Sem vaga em número nenhum hoje: o contato espera o próximo dia. Numa campanha, o próximo dia permitido na abertura da
  // janela; numa execução da API, o começo do dia seguinte. Amanhã ele conta na cota de amanhã.
  const tomorrow = spInstant(addDays(today, 1), 0);
  if (!campaign) return postponeRun(tx, run, tomorrow);
  const opening = nextScheduleOpening(tomorrow, scheduleOf(campaign));
  return opening ? postponeRun(tx, run, opening) : cancelRun(tx, run, REASON.endDate);
}

/** Volta a esperar, sem mudar nada (automação ou campanha pausada entre o claim e agora). */
async function releaseRun(tx: Tx, run: AutomationRun): Promise<Outcome> {
  await tx
    .updateTable('automation_runs')
    .set({ status: 'pending', updated_at: sql`now()` })
    .where('id', '=', run.id)
    .where('status', '=', 'running')
    .execute();
  return { kind: 'released' };
}

/** Fora da janela de horário da campanha: espera abrir a janela. */
async function postponeRun(tx: Tx, run: AutomationRun, at: Date): Promise<Outcome> {
  await tx
    .updateTable('automation_runs')
    .set({ status: 'pending', next_run_at: at, updated_at: sql`now()` })
    .where('id', '=', run.id)
    .where('status', '=', 'running')
    .execute();
  return { kind: 'released' };
}

/**
 * Primeiro envio de uma campanha: o lead passa a "Chamado · Mensagem enviada" (o mesmo que o Chamar faz), sem
 * atendente. Assim ele sai da fila livre e o resultado muda sozinho para "Respondeu" quando ele responder.
 * Só mexe em lead que ainda está pendente e sem atendente.
 */
async function markContactedByCampaign(
  tx: Tx,
  leadId: number,
  campaignId: number,
  instance: WaInstance,
): Promise<void> {
  const updated = await tx
    .updateTable('leads')
    .set({
      status: 'chamado',
      called_at: sql`now()`,
      result: 'enviado',
      callback_at: null,
      version: sql`version + 1`,
      updated_at: sql`now()`,
    })
    .where('id', '=', leadId)
    .where('status', '=', 'pendente')
    .where('assigned_to', 'is', null)
    .where('anonymized_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (!updated) return;
  await addEvents(tx, [
    {
      leadId,
      userId: null,
      type: 'chamado',
      data: {
        resultado: 'enviado',
        automatico: true,
        campanha: campaignId,
        numero: instance.nickname ?? instance.name,
      },
    },
  ]);
}

/** O telefone não tem WhatsApp: o lead sai da fila livre como "Sem WhatsApp" (igual ao fluxo manual) e a campanha segue. */
async function markLeadWithoutWhatsapp(tx: Tx, leadId: number, campaignId: number): Promise<void> {
  const updated = await tx
    .updateTable('leads')
    .set({
      status: 'chamado',
      called_at: sql`now()`,
      result: 'sem_whatsapp',
      callback_at: null,
      version: sql`version + 1`,
      updated_at: sql`now()`,
    })
    .where('id', '=', leadId)
    .where('status', '=', 'pendente')
    .where('assigned_to', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (!updated) return;
  await addEvents(tx, [
    {
      leadId,
      userId: null,
      type: 'chamado',
      data: { resultado: 'sem_whatsapp', automatico: true, campanha: campaignId },
    },
  ]);
}

/** Já havia uma tentativa desta etapa: decide se dá para seguir (só quando ela ainda não saiu) ou se encerra. */
async function resolveExisting(
  tx: Tx,
  run: AutomationRun,
  step: AutomationStepRow,
  existing: AutomationStepRun,
  now: Date,
): Promise<Outcome | null> {
  switch (existing.status) {
    case 'completed':
    case 'skipped':
      // Etapa já feita (o processo caiu antes de avançar): só avança. Não envia de novo.
      return advanceRun(tx, run, now, { kind: 'noop' });
    case 'running':
      // Alguém começou o envio e não terminou: não dá para saber se saiu. Não reenvia.
      return failStep(
        tx,
        run,
        step,
        existing,
        REASON.interrupted,
        'O envio desta etapa foi interrompido e não dá para saber se a mensagem saiu. Não foi reenviada.',
      );
    case 'pending':
      if (existing.attempts >= MAX_ATTEMPTS) {
        return failStep(
          tx,
          run,
          step,
          existing,
          'tentativas_esgotadas',
          `A etapa não foi enviada depois de ${existing.attempts} tentativas (número desconectado).`,
        );
      }
      return null; // nova tentativa: a mensagem sabidamente não saiu
    default:
      return failStep(tx, run, step, existing, 'erro_interno', existing.error ?? 'A etapa já tinha falhado.');
  }
}

/** Dados reais do lead para as variáveis da mensagem. */
async function renderData(
  tx: Tx,
  run: AutomationRun,
  lead: LeadForRun,
  instance: WaInstance,
): Promise<RenderData> {
  const attendantId = run.started_by ?? lead.called_by ?? lead.assigned_to ?? instance.owner_id;
  const attendant = attendantId
    ? ((await tx.selectFrom('users').select('name').where('id', '=', attendantId).executeTakeFirst())?.name ??
      null)
    : null;
  const own = instance.phone_jid ? displayPhone(instance.phone_jid.split('@')[0] ?? '') : '';
  return {
    name: lead.name,
    company: lead.company,
    phone: displayPhone(lead.phone),
    attendant,
    number: own || instance.nickname || instance.name,
  };
}

// ---------- transições da participação (todas condicionais a "running") ----------

/** Encerra a participação (só se ainda estiver "running": uma resposta do lead pode ter cancelado antes). */
async function finishRun(
  tx: Tx,
  run: AutomationRun,
  status: 'cancelled' | 'failed' | 'completed',
  reason: string | null,
  options: { audit?: { action: string; details?: Record<string, unknown> } } = {},
): Promise<boolean> {
  const updated = await tx
    .updateTable('automation_runs')
    .set({
      status,
      next_run_at: null,
      cancel_reason: reason,
      completed_at: status === 'completed' ? sql`now()` : null,
      cancelled_at: status === 'cancelled' ? sql`now()` : null,
      updated_at: sql`now()`,
    })
    .where('id', '=', run.id)
    .where('status', '=', 'running')
    .returning('id')
    .executeTakeFirst();
  if (!updated) return false;
  if (options.audit) {
    await audit(tx, {
      userId: null,
      action: options.audit.action,
      entity: 'automacao',
      entityId: run.automation_id,
      details: {
        execucao: run.id,
        lead: run.lead_id,
        etapa: run.current_step,
        motivo: reason,
        ...options.audit.details,
      },
    });
  }
  return true;
}

async function cancelRun(tx: Tx, run: AutomationRun, reason: string): Promise<Outcome> {
  await finishRun(tx, run, 'cancelled', reason, { audit: { action: 'cancelou_execucao_automacao' } });
  await tx
    .updateTable('automation_step_runs')
    .set({ status: 'cancelled', finished_at: sql`now()`, updated_at: sql`now()` })
    .where('automation_run_id', '=', run.id)
    .where('status', '=', 'pending')
    .execute();
  return { kind: 'cancelled' };
}

async function completeRun(tx: Tx, run: AutomationRun): Promise<Outcome> {
  await finishRun(tx, run, 'completed', null, { audit: { action: 'concluiu_execucao_automacao' } });
  return { kind: 'noop', completed: true };
}

/** Número desconectado: volta a esperar e tenta de novo daqui a `RETRY_SECONDS` (sem laço rápido). */
async function reschedule(tx: Tx, run: AutomationRun, now: Date): Promise<Outcome> {
  await tx
    .updateTable('automation_runs')
    .set({ status: 'pending', next_run_at: scheduleAfter(now, RETRY_SECONDS), updated_at: sql`now()` })
    .where('id', '=', run.id)
    .where('status', '=', 'running')
    .execute();
  return { kind: 'rescheduled' };
}

/**
 * A etapa terminou (enviada ou pulada): vai para a próxima, com a espera DELA contada daqui. Se não houver
 * próxima, a participação termina. `outcome.kind` diz o que a etapa foi.
 */
async function advanceRun(tx: Tx, run: AutomationRun, now: Date, outcome: Outcome): Promise<Outcome> {
  const next = await tx
    .selectFrom('automation_steps')
    .select(['position', 'delay_seconds'])
    .where('automation_id', '=', run.automation_id)
    .where('position', '>', run.current_step)
    .orderBy('position')
    .limit(1)
    .executeTakeFirst();
  if (!next) {
    const done = await finishRun(tx, run, 'completed', null, {
      audit: { action: 'concluiu_execucao_automacao' },
    });
    return { ...outcome, completed: done };
  }
  let at = scheduleAfter(now, next.delay_seconds);
  if (run.campaign_id !== null) {
    const campaign = await tx
      .selectFrom('automation_campaigns')
      .selectAll()
      .where('id', '=', run.campaign_id)
      .executeTakeFirst();
    if (campaign) at = nextScheduleOpening(at, followUpSchedule(scheduleOf(campaign))) ?? at;
  }
  await tx
    .updateTable('automation_runs')
    .set({
      status: 'pending',
      current_step: next.position,
      next_run_at: at,
      updated_at: sql`now()`,
    })
    .where('id', '=', run.id)
    .where('status', '=', 'running')
    .execute();
  return outcome;
}

/** Grava a etapa como pulada (com a explicação) sem enviar nada. */
async function recordSkipped(
  tx: Tx,
  run: AutomationRun,
  step: AutomationStepRow,
  existing: AutomationStepRun | undefined,
  explanation: string,
  now: Date,
): Promise<void> {
  if (existing) {
    await tx
      .updateTable('automation_step_runs')
      .set({ status: 'skipped', error: explanation, finished_at: now, updated_at: sql`now()` })
      .where('id', '=', existing.id)
      .execute();
  } else {
    await tx
      .insertInto('automation_step_runs')
      .values({
        automation_run_id: run.id,
        step_id: step.id,
        status: 'skipped',
        scheduled_at: run.next_run_at ?? now,
        finished_at: now,
        error: explanation,
      })
      .execute();
  }
  await audit(tx, {
    userId: null,
    action: 'pulou_etapa_automacao',
    entity: 'automacao',
    entityId: run.automation_id,
    details: { execucao: run.id, lead: run.lead_id, etapa: step.position },
  });
}

/** A etapa falhou (sem enviar, ou sem certeza): registra o erro e encerra a participação como "failed". */
async function failStep(
  tx: Tx,
  run: AutomationRun,
  step: AutomationStepRow,
  existing: AutomationStepRun | undefined,
  code: string,
  error: string,
): Promise<Outcome> {
  if (existing) {
    await tx
      .updateTable('automation_step_runs')
      .set({ status: 'failed', error, finished_at: sql`now()`, updated_at: sql`now()` })
      .where('id', '=', existing.id)
      .execute();
  } else {
    await tx
      .insertInto('automation_step_runs')
      .values({
        automation_run_id: run.id,
        step_id: step.id,
        status: 'failed',
        scheduled_at: run.next_run_at ?? new Date(),
        finished_at: new Date(),
        error,
      })
      .execute();
  }
  await finishRun(tx, run, 'failed', code, {
    audit: { action: 'falhou_etapa_automacao', details: { etapa: step.position, tipo: step.action_type } },
  });
  return { kind: 'failed' };
}

// ---------- fase 2: enviar (fora de transação: nada travado durante a chamada à Evolution) ----------

/** Descrição curta de um erro qualquer, sem dados do lead. */
const describeError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function deliver(db: Db, ctx: SendContext): Promise<Delivery> {
  // Objeto (e não variáveis soltas): o TypeScript não acompanha o que uma closure altera em `let`.
  const state = {
    sendCalled: false,
    sentKey: undefined as string | undefined,
    evolutionError: null as unknown,
  };
  try {
    let conversationId = ctx.conversation?.id;
    if (conversationId === undefined) {
      // Primeira vez deste lead neste número (execução manual): confere o telefone e abre a conversa pelo
      // mesmo caminho do "Chamar". Nada foi enviado ainda: falha aqui é segura para repetir depois.
      const check = await evolution
        .whatsappNumbers(ctx.instance.name, [ctx.lead.phone])
        .then((r) => (Array.isArray(r) ? r[0] : undefined))
        .catch((error) => {
          throw new AppError(
            502,
            `Não foi possível conferir o telefone do lead: ${describeError(error)}`,
            'whatsapp',
          );
        });
      if (!check) throw new AppError(502, 'Não foi possível conferir o telefone do lead.', 'whatsapp');
      if (!check.exists) {
        return {
          ok: false,
          retry: false,
          notSent: true,
          code: 'sem_whatsapp',
          error: 'O telefone do lead não tem WhatsApp.',
        };
      }
      const jids = contactJidsOf(check, ctx.lead.phone);
      conversationId = (await enqueue(() => openLeadConversation(db, ctx.instance.id, jids, ctx.lead.id))).id;
    }

    const audioBytes = ctx.message.kind === 'audio' ? await readAudioBytes(ctx.message.audio.path) : null;
    const send = async (name: string, number: string): Promise<RawMessage> => {
      state.sendCalled = true;
      try {
        const sent =
          ctx.message.kind === 'text'
            ? await evolution.sendText(name, number, ctx.message.text)
            : await evolution.sendAudio(name, number, (audioBytes as Buffer).toString('base64'));
        state.sentKey = sent.key.id;
        return sent;
      } catch (error) {
        state.evolutionError = error;
        throw error;
      }
    };
    const media =
      ctx.message.kind === 'audio' && audioBytes
        ? { data: audioBytes, mime: ctx.message.audio.mime }
        : undefined;
    const message = await sendAndStore(
      db,
      conversationId,
      // Envio automático: sem pessoa, sem marcar o lead como chamado, sem mexer na fila e sem marcar lidas.
      { userId: null, markLeadCalled: false, markRead: false },
      send,
      media,
    );
    return { ok: true, messageId: message.id };
  } catch (error) {
    if (state.sentKey) {
      // A Evolution aceitou o envio; só a gravação na conversa falhou. A mensagem SAIU: não é falha de envio.
      const found = await db
        .selectFrom('wa_messages')
        .select('id')
        .where('instance_id', '=', ctx.instance.id)
        .where('wa_id', '=', state.sentKey)
        .executeTakeFirst()
        .catch(() => undefined);
      return {
        ok: true,
        messageId: found?.id ?? null,
        warning: `A mensagem foi enviada, mas não foi gravada na conversa: ${describeError(error)}`,
      };
    }
    return classifyFailure(error, state.evolutionError, state.sendCalled);
  }
}

/**
 * Erro antes de a Evolution aceitar o envio. Só é "seguro repetir" quando SABEMOS que a mensagem não saiu:
 * antes de chamar o envio (número desconectado, conferência que falhou) ou recusa clara de desconexão.
 * Qualquer outra coisa depois de chamar o envio (5xx, timeout, queda) é resultado incerto: não reenvia.
 */
function classifyFailure(error: unknown, evolutionError: unknown, sendCalled: boolean): Delivery {
  const cause = evolutionError ?? error;
  if (cause instanceof EvolutionError) {
    if (cause.status >= 400 && cause.status < 500) {
      if (/desconectado/i.test(cause.reason)) {
        return {
          ok: false,
          retry: true,
          notSent: true,
          code: 'tentativas_esgotadas',
          error: `Número desconectado: ${cause.reason}`,
        };
      }
      return {
        ok: false,
        retry: false,
        notSent: true,
        code: 'envio_recusado',
        error: `A Evolution recusou o envio (${cause.status}): ${cause.reason}`,
      };
    }
    return {
      ok: false,
      retry: false,
      notSent: false,
      code: 'resultado_incerto',
      error: `A Evolution respondeu com erro ${cause.status}: ${cause.reason}. Não foi reenviada, pois não dá para saber se a mensagem saiu.`,
    };
  }
  if (!sendCalled && error instanceof AppError) {
    // Antes de tentar enviar: número desconectado (409) ou conferência que falhou (502). Nada saiu.
    if (error.statusCode === 409 || error.statusCode === 502) {
      return { ok: false, retry: true, notSent: true, code: 'tentativas_esgotadas', error: error.message };
    }
    return { ok: false, retry: false, notSent: true, code: 'erro_interno', error: error.message };
  }
  return {
    ok: false,
    retry: false,
    // Depois de chamar o envio, qualquer erro que não seja a recusa clara deixa a dúvida: a vaga fica ocupada.
    notSent: !sendCalled,
    code: sendCalled ? 'resultado_incerto' : 'erro_interno',
    error: sendCalled
      ? `Sem resposta clara da Evolution (${describeError(error)}). Não foi reenviada, pois não dá para saber se a mensagem saiu.`
      : `Erro antes do envio: ${describeError(error)}`,
  };
}

// ---------- fase 3: gravar o resultado ----------

/**
 * Resultado do envio → a vaga da cota. Aceito: vira contato AUTOMÁTICO. Sabidamente não saiu (recusa, número
 * desconectado, erro antes do envio): a vaga volta. Resultado incerto: a vaga CONTINUA ocupada como incerta, e a etapa
 * nunca é reenviada às cegas. Assim o número nunca passa do limite.
 */
async function settleQuota(tx: Tx, ctx: SendContext, delivery: Delivery): Promise<void> {
  const { claim, campaign } = ctx;
  if (!claim) return;
  if (delivery.ok) {
    const usage = await confirmContactQuota(tx, claim, 'automatic');
    const cap = effectiveLimit(campaign?.daily_limit);
    if (usage && usage.total >= cap) {
      await auditContactLimit(tx, {
        instanceId: claim.instanceId,
        usage: usageOf(usage, usage.date, cap),
        origin: campaign ? 'campanha' : 'api',
        situation: 'atingido',
        campaignId: campaign?.id ?? null,
      });
    }
    return;
  }
  if (delivery.notSent) await releaseContactQuota(tx, claim);
}

async function finalize(tx: Tx, ctx: SendContext, delivery: Delivery, now: Date): Promise<Outcome> {
  const { run, step, stepRun } = ctx;
  const run2 = await tx
    .selectFrom('automation_runs')
    .selectAll()
    .where('id', '=', run.id)
    .forUpdate()
    .executeTakeFirst();

  // Cota diária do número: confirma, devolve ou mantém a vaga que foi segurada antes do envio.
  await settleQuota(tx, ctx, delivery);

  if (delivery.ok) {
    await tx
      .updateTable('automation_step_runs')
      .set({
        status: 'completed',
        message_id: delivery.messageId,
        error: delivery.warning ?? null,
        finished_at: now,
        updated_at: sql`now()`,
      })
      .where('id', '=', stepRun.id)
      .execute();
    await audit(tx, {
      userId: null,
      action: 'enviou_etapa_automacao',
      entity: 'automacao',
      entityId: run.automation_id,
      details: {
        execucao: run.id,
        lead: run.lead_id,
        etapa: step.position,
        tipo: step.action_type,
        numero: ctx.instance.id,
        mensagem: delivery.messageId,
        ...(run.campaign_id !== null ? { campanha: run.campaign_id } : {}),
        ...(ctx.message.kind === 'audio' ? { audio: ctx.message.audio.id } : {}),
      },
    });
    if (run.campaign_id !== null)
      await markContactedByCampaign(tx, ctx.lead.id, run.campaign_id, ctx.instance);
    // Se o lead respondeu (ou alguém cancelou) enquanto enviava, a participação já está encerrada: fica assim.
    if (run2?.status !== 'running') return { kind: 'sent' };
    return advanceRun(tx, run2, now, { kind: 'sent' });
  }

  if (delivery.retry) {
    // A mensagem sabidamente não saiu: a tentativa volta a "pending" e a participação espera para tentar de novo.
    if (stepRun.attempts >= MAX_ATTEMPTS) {
      const error = `A etapa não foi enviada depois de ${stepRun.attempts} tentativas: ${delivery.error}`;
      await tx
        .updateTable('automation_step_runs')
        .set({ status: 'failed', error, finished_at: now, updated_at: sql`now()` })
        .where('id', '=', stepRun.id)
        .execute();
      if (run2?.status === 'running') {
        await finishRun(tx, run2, 'failed', 'tentativas_esgotadas', {
          audit: {
            action: 'falhou_etapa_automacao',
            details: { etapa: step.position, tipo: step.action_type },
          },
        });
      }
      return { kind: 'failed' };
    }
    await tx
      .updateTable('automation_step_runs')
      .set({ status: 'pending', error: delivery.error, updated_at: sql`now()` })
      .where('id', '=', stepRun.id)
      .execute();
    if (run2?.status === 'running') await reschedule(tx, run2, now);
    return { kind: 'rescheduled' };
  }

  await tx
    .updateTable('automation_step_runs')
    .set({ status: 'failed', error: delivery.error, finished_at: now, updated_at: sql`now()` })
    .where('id', '=', stepRun.id)
    .execute();
  if (delivery.code === 'sem_whatsapp' && run.campaign_id !== null) {
    await markLeadWithoutWhatsapp(tx, ctx.lead.id, run.campaign_id);
    await audit(tx, {
      userId: null,
      action: 'lead_ignorado_campanha',
      entity: 'automacao',
      entityId: run.automation_id,
      details: { campanha: run.campaign_id, execucao: run.id, lead: run.lead_id, motivo: 'sem_whatsapp' },
    });
  }
  if (run2?.status === 'running') {
    await finishRun(tx, run2, 'failed', delivery.code, {
      audit: {
        action: 'falhou_etapa_automacao',
        details: { etapa: step.position, tipo: step.action_type, numero: ctx.instance.id },
      },
    });
  }
  return { kind: 'failed' };
}
