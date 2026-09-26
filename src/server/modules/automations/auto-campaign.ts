/**
 * Campanha automática: a campanha pré-definida pelo sistema. O gestor só clica em Ativar ou Pausar.
 *
 * Por baixo é o MESMO motor das campanhas (nada foi duplicado):
 * - uma automação do sistema (`system_key = 'campanha_automatica'`) com UMA etapa: áudio sorteado da biblioteca;
 * - uma campanha dessa automação com `all_lists` (a fila livre de todas as listas não arquivadas) e `all_numbers` (todos
 *   os números cadastrados; número novo entra sozinho), dias úteis, das 10:00 às 16:00 (São Paulo), 20 por número/dia;
 * - a fila (`queue.ts`) escolhe o lead e o número menos usado (empate por sorteio); o executor (`executor.ts`) segura a
 *   vaga da cota, sorteia o áudio no rodízio persistente e envia. Tudo no PostgreSQL, nada em memória.
 *
 * Ativar cria a campanha (ou retoma a pausada); ela fica ligada até alguém pausar, e fora do horário só espera. Ela não
 * termina quando a fila esvazia: leads novos entram a cada importação.
 */
import { sql } from 'kysely';
import {
  AUTO_CAMPAIGN,
  type AutoCampaignCounts,
  type AutoCampaignNumber,
  type AutoCampaignPhase,
  type AutoCampaignState,
  type AutoCampaignStatus,
} from '../../../shared/auto-campaign';
import { formatClock } from '../../../shared/automations';
import { formatDays, weekdayLong } from '../../../shared/campaign-plan';
import type { AuthUser } from '../../auth/sessions';
import type { Db } from '../../db';
import type { AutomationCampaign } from '../../db/schema';
import { audit } from '../../lib/audit';
import { conflict } from '../../lib/errors';
import { instanceUsage } from '../whatsapp/quota';
import { publishCampaignChange } from '../whatsapp/realtime';
import { countCampaignEligibleLeads } from './campaign-audience';
import { respaceOverdue } from './campaigns';
import { hasActiveAudio } from './queue';
import { lockAutomation } from './service';
import {
  addDays,
  dayAllowed,
  isoWeekday,
  nextScheduleOpening,
  type Schedule,
  spDate,
  spInstant,
  spTime,
} from './window';

export const AUTO_CAMPAIGN_KEY = 'campanha_automatica';

/** Trava própria para criar a automação do sistema (dois cliques em Ativar ao mesmo tempo criam uma só). */
const PROVISION_LOCK = 720_200;

/** A agenda fixa: dias úteis, 10:00 às 16:00, sem data de início nem de fim. */
export const AUTO_SCHEDULE: Schedule = {
  startMin: AUTO_CAMPAIGN.windowStartMin,
  endMin: AUTO_CAMPAIGN.windowEndMin,
  days: AUTO_CAMPAIGN.days,
  startDate: null,
  endDate: null,
};

/** O id da automação do sistema, se ela já existe (a leitura nunca cria nada). */
async function findAutomationId(db: Db): Promise<number | null> {
  const row = await db
    .selectFrom('automations')
    .select('id')
    .where('system_key', '=', AUTO_CAMPAIGN_KEY)
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Cria (uma vez) a automação do sistema e garante que ela tem exatamente a etapa certa: enviar um áudio sorteado, sem
 * espera. Se alguém mexeu direto no banco, a etapa volta ao padrão. Devolve o id.
 */
export async function ensureAutoAutomation(db: Db): Promise<number> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${PROVISION_LOCK})`.execute(trx);
    let automation = await trx
      .selectFrom('automations')
      .select(['id', 'status'])
      .where('system_key', '=', AUTO_CAMPAIGN_KEY)
      .executeTakeFirst();
    if (!automation) {
      automation = await trx
        .insertInto('automations')
        .values({
          name: AUTO_CAMPAIGN.name,
          description: AUTO_CAMPAIGN.description,
          status: 'active',
          trigger_type: 'manual',
          system_key: AUTO_CAMPAIGN_KEY,
        })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
    } else if (automation.status !== 'active') {
      await trx
        .updateTable('automations')
        .set({ status: 'active', archived_at: null, updated_at: sql`now()` })
        .where('id', '=', automation.id)
        .execute();
    }
    const steps = await trx
      .selectFrom('automation_steps')
      .select(['position', 'action_type', 'audio_mode', 'delay_seconds', 'conditions'])
      .where('automation_id', '=', automation.id)
      .execute();
    const [only] = steps;
    const canonical =
      steps.length === 1 &&
      only?.position === 1 &&
      only.action_type === 'send_audio' &&
      only.audio_mode === 'random' &&
      only.delay_seconds === 0 &&
      only.conditions.length === 0;
    if (!canonical) {
      await trx.deleteFrom('automation_steps').where('automation_id', '=', automation.id).execute();
      await trx
        .insertInto('automation_steps')
        .values({
          automation_id: automation.id,
          position: 1,
          action_type: 'send_audio',
          delay_seconds: 0,
          audio_mode: 'random',
          audio_id: null,
          message_text: null,
          conditions: '[]',
        })
        .execute();
    }
    return automation.id;
  });
}

/** A campanha da automação do sistema: a viva (ativa ou pausada), senão a mais recente. */
async function currentCampaign(db: Db, automationId: number): Promise<AutomationCampaign | undefined> {
  return db
    .selectFrom('automation_campaigns')
    .selectAll()
    .where('automation_id', '=', automationId)
    .orderBy(sql`(status IN ('active', 'paused'))`, 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
}

// ---------- ações ----------

/**
 * Liga a campanha automática. Precisa de pelo menos um áudio no sorteio e um número cadastrado (se nenhum estiver
 * conectado, ela espera). Já ativa: não muda nada. Pausada: retoma de onde parou, sem repetir lead.
 */
export async function activateAutoCampaign(
  db: Db,
  user: AuthUser,
  ip: string | null,
  now = new Date(),
): Promise<AutoCampaignState> {
  if (!(await hasActiveAudio(db))) {
    throw conflict('Salve pelo menos um áudio na aba Áudios (e deixe no sorteio) antes de ativar.');
  }
  const anyNumber = await db.selectFrom('wa_instances').select('id').limit(1).executeTakeFirst();
  if (!anyNumber) throw conflict('Cadastre um número de WhatsApp na aba Números antes de ativar.');

  const automationId = await ensureAutoAutomation(db);
  const campaignId = await db.transaction().execute(async (trx) => {
    // Mesma ordem de travas do resto das campanhas: automação, depois campanha.
    await lockAutomation(trx, automationId);
    const live = await trx
      .selectFrom('automation_campaigns')
      .selectAll()
      .where('automation_id', '=', automationId)
      .where('status', 'in', ['active', 'paused'])
      .forUpdate()
      .executeTakeFirst();
    if (live?.status === 'active') return live.id;
    if (live) {
      await trx
        .updateTable('automation_campaigns')
        .set({ status: 'active', updated_at: sql`now()` })
        .where('id', '=', live.id)
        .execute();
      const respaced = await respaceOverdue(trx, live.id, now);
      await audit(trx, {
        userId: user.id,
        action: 'ativou_campanha_automatica',
        entity: 'automacao',
        entityId: automationId,
        details: { campanha: live.id, retomada: true, envios_reagendados: respaced },
        ip,
      });
      return live.id;
    }
    const created = await trx
      .insertInto('automation_campaigns')
      .values({
        automation_id: automationId,
        list_id: null,
        all_lists: true,
        all_numbers: true,
        instance_ids: [],
        window_start_min: AUTO_CAMPAIGN.windowStartMin,
        window_end_min: AUTO_CAMPAIGN.windowEndMin,
        daily_limit: AUTO_CAMPAIGN.dailyLimitPerNumber,
        start_date: spDate(now),
        end_date: null,
        days_of_week: [...AUTO_CAMPAIGN.days],
        cooldown_hours: AUTO_CAMPAIGN.cooldownHours,
        filters: '{}',
        started_by: user.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(trx, {
      userId: user.id,
      action: 'ativou_campanha_automatica',
      entity: 'automacao',
      entityId: automationId,
      details: { campanha: created.id, retomada: false },
      ip,
    });
    return created.id;
  });
  void publishCampaignChange([campaignId]);
  return autoCampaignState(db, now);
}

/** Desliga: nenhum lead novo é reservado e nada sai. O que já foi enviado e a cota do dia ficam como estão. */
export async function pauseAutoCampaign(
  db: Db,
  user: AuthUser,
  ip: string | null,
  now = new Date(),
): Promise<AutoCampaignState> {
  const automationId = await findAutomationId(db);
  if (automationId === null) return autoCampaignState(db, now);
  const paused = await db.transaction().execute(async (trx) => {
    await lockAutomation(trx, automationId);
    const live = await trx
      .selectFrom('automation_campaigns')
      .select('id')
      .where('automation_id', '=', automationId)
      .where('status', '=', 'active')
      .forUpdate()
      .executeTakeFirst();
    if (!live) return null;
    await trx
      .updateTable('automation_campaigns')
      .set({ status: 'paused', updated_at: sql`now()` })
      .where('id', '=', live.id)
      .execute();
    await audit(trx, {
      userId: user.id,
      action: 'pausou_campanha_automatica',
      entity: 'automacao',
      entityId: automationId,
      details: { campanha: live.id },
      ip,
    });
    return live.id;
  });
  if (paused !== null) void publishCampaignChange([paused]);
  return autoCampaignState(db, now);
}

// ---------- estado e métricas ----------

const emptyCounts = (): AutoCampaignCounts => ({ sent: 0, noWhatsapp: 0, replied: 0, notReplied: 0 });

/**
 * Enviados, sem WhatsApp e respostas, de hoje (São Paulo) e desde sempre. "Respondeu" = o lead mandou alguma mensagem na
 * conversa daquele número depois do áudio. As contas de "hoje" olham os leads que RECEBERAM o áudio hoje.
 */
async function countsOf(
  db: Db,
  automationId: number,
  now: Date,
): Promise<{ today: AutoCampaignCounts; total: AutoCampaignCounts }> {
  const today = spDate(now);
  const dayStart = spInstant(today, 0);
  const dayEnd = spInstant(addDays(today, 1), 0);
  const sent = await sql<{ total: number; today: number; replied_total: number; replied_today: number }>`
    WITH sent AS (
      SELECT r.lead_id, r.instance_id, sr.finished_at,
             COALESCE(m.sent_at, sr.started_at, sr.finished_at) AS base
      FROM automation_runs r
      JOIN automation_step_runs sr ON sr.automation_run_id = r.id AND sr.status = 'completed'
      LEFT JOIN wa_messages m ON m.id = sr.message_id
      WHERE r.automation_id = ${automationId}
        AND sr.id = (SELECT min(x.id) FROM automation_step_runs x WHERE x.automation_run_id = r.id)
    ),
    flagged AS (
      SELECT s.finished_at,
             EXISTS (
               SELECT 1 FROM wa_conversations c
               JOIN wa_messages i ON i.conversation_id = c.id
               WHERE c.lead_id = s.lead_id AND c.instance_id = s.instance_id
                 AND NOT i.from_me AND i.sent_at >= s.base
             ) AS replied
      FROM sent s
    )
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE finished_at >= ${dayStart} AND finished_at < ${dayEnd})::int AS today,
           count(*) FILTER (WHERE replied)::int AS replied_total,
           count(*) FILTER (WHERE replied AND finished_at >= ${dayStart} AND finished_at < ${dayEnd})::int AS replied_today
    FROM flagged`.execute(db);
  // Pela tentativa da etapa (quando a conferência do telefone respondeu "sem WhatsApp"), no dia em que aconteceu.
  const noWhatsapp = await sql<{ total: number; today: number }>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE sr.finished_at >= ${dayStart} AND sr.finished_at < ${dayEnd})::int AS today
    FROM automation_runs r
    JOIN automation_step_runs sr ON sr.automation_run_id = r.id
    WHERE r.automation_id = ${automationId} AND r.status = 'failed' AND r.cancel_reason = 'sem_whatsapp'
      AND sr.id = (SELECT min(x.id) FROM automation_step_runs x WHERE x.automation_run_id = r.id)`.execute(
    db,
  );
  const s = sent.rows[0];
  const n = noWhatsapp.rows[0];
  const build = (sentN: number, replied: number, noWa: number): AutoCampaignCounts => ({
    sent: sentN,
    noWhatsapp: noWa,
    replied,
    notReplied: Math.max(0, sentN - replied),
  });
  return {
    today: build(s?.today ?? 0, s?.replied_today ?? 0, n?.today ?? 0),
    total: build(s?.total ?? 0, s?.replied_total ?? 0, n?.total ?? 0),
  };
}

/** Todos os números cadastrados, com o uso de hoje da cota (manual + automático + incerto). */
async function numbersToday(db: Db, now: Date): Promise<AutoCampaignNumber[]> {
  const rows = await db
    .selectFrom('wa_instances')
    .select(['id', 'name', 'nickname', 'status'])
    .orderBy('id')
    .execute();
  const usage = await instanceUsage(
    db,
    rows.map((r) => r.id),
    spDate(now),
    AUTO_CAMPAIGN.dailyLimitPerNumber,
  );
  return rows.map((r) => {
    const u = usage.get(r.id);
    return {
      id: r.id,
      label: r.nickname || r.name,
      connected: r.status === 'open',
      usedToday: u?.total ?? 0,
      limit: u?.limit ?? AUTO_CAMPAIGN.dailyLimitPerNumber,
      remainingToday: u?.remaining ?? AUTO_CAMPAIGN.dailyLimitPerNumber,
      automaticToday: u?.automatic ?? 0,
    };
  });
}

function phaseOf(status: AutoCampaignStatus, now: Date): AutoCampaignPhase {
  if (status !== 'active') return 'off';
  const t = spTime(now);
  if (!dayAllowed(t.date, AUTO_SCHEDULE)) return 'not_a_run_day';
  if (t.minutes < AUTO_SCHEDULE.startMin) return 'before_window';
  if (t.minutes >= AUTO_SCHEDULE.endMin) return 'after_window';
  return 'sending';
}

function headlineOf(
  status: AutoCampaignStatus,
  phase: AutoCampaignPhase,
  next: Date | null,
  now: Date,
): string {
  if (status === 'off') return 'Desativada';
  if (status === 'paused') return 'Pausada';
  const opens = formatClock(AUTO_SCHEDULE.startMin);
  if (phase === 'sending') return 'Ativa · enviando agora';
  if (phase === 'before_window') return `Ativa · começa hoje às ${opens}`;
  if (!next) return 'Ativa';
  const nextDate = spDate(next);
  if (nextDate === addDays(spDate(now), 1)) return `Ativa · volta amanhã às ${opens}`;
  return `Ativa · volta na ${weekdayLong(isoWeekday(nextDate)).toLowerCase()} às ${opens}`;
}

/** Tudo o que a aba Automações mostra: situação, regra fixa, métricas, números e avisos. Só lê o banco. */
export async function autoCampaignState(db: Db, now = new Date()): Promise<AutoCampaignState> {
  const automationId = await findAutomationId(db);
  const campaign = automationId === null ? undefined : await currentCampaign(db, automationId);
  const status: AutoCampaignStatus =
    campaign?.status === 'active' ? 'active' : campaign?.status === 'paused' ? 'paused' : 'off';
  const phase = phaseOf(status, now);
  const next = status === 'active' && phase !== 'sending' ? nextScheduleOpening(now, AUTO_SCHEDULE) : null;

  const numbers = await numbersToday(db, now);
  const connected = numbers.filter((n) => n.connected);
  const t = spTime(now);
  const todayRuns = dayAllowed(t.date, AUTO_SCHEDULE) && t.minutes < AUTO_SCHEDULE.endMin;
  const capacityToday = todayRuns ? connected.reduce((sum, n) => sum + n.remainingToday, 0) : 0;

  // Quem ainda pode receber: os elegíveis da fila livre mais os já reservados que ainda não saíram.
  const eligible = await countCampaignEligibleLeads(
    db,
    {
      listId: null,
      automationId: automationId ?? 0,
      campaignId: campaign?.id ?? null,
      filters: {},
      cooldownHours: AUTO_CAMPAIGN.cooldownHours,
    },
    now,
  );
  const waiting =
    campaign && (campaign.status === 'active' || campaign.status === 'paused')
      ? Number(
          (
            await db
              .selectFrom('automation_runs')
              .select((eb) => eb.fn.countAll<number>().as('n'))
              .where('campaign_id', '=', campaign.id)
              .where('status', 'in', ['pending', 'running'])
              .where('current_step', '=', 1)
              .executeTakeFirstOrThrow()
          ).n,
        )
      : 0;
  const available = eligible + waiting;

  const counts =
    automationId === null
      ? { today: emptyCounts(), total: emptyCounts() }
      : await countsOf(db, automationId, now);
  const activeAudios = Number(
    (
      await db
        .selectFrom('wa_audios')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('active', '=', true)
        .where('media_path', '<>', '')
        .executeTakeFirstOrThrow()
    ).n,
  );

  const warnings: string[] = [];
  if (activeAudios === 0) warnings.push('Nenhum áudio no sorteio: salve ou ligue um áudio na aba Áudios.');
  if (!numbers.length) warnings.push('Nenhum número cadastrado: cadastre um na aba Números.');
  else if (!connected.length)
    warnings.push('Nenhum número conectado agora: conecte pelo menos um na aba Números.');
  else if (connected.every((n) => n.remainingToday === 0)) {
    warnings.push(
      `Todos os números conectados já fizeram os ${AUTO_CAMPAIGN.dailyLimitPerNumber} contatos de hoje: o resto fica para o próximo dia útil.`,
    );
  }
  if (available === 0) {
    warnings.push('Não há leads na fila livre para enviar: importe uma lista ou devolva leads para a fila.');
  }

  return {
    status,
    phase,
    headline: headlineOf(status, phase, next, now),
    nextOpening: next ? next.toISOString() : null,
    activatedAt: campaign ? campaign.started_at.toISOString() : null,
    activatedBy: campaign?.started_by
      ? ((
          await db.selectFrom('users').select('name').where('id', '=', campaign.started_by).executeTakeFirst()
        )?.name ?? null)
      : null,
    rules: {
      windowStart: formatClock(AUTO_CAMPAIGN.windowStartMin),
      windowEnd: formatClock(AUTO_CAMPAIGN.windowEndMin),
      days: formatDays(AUTO_CAMPAIGN.days),
      dailyLimitPerNumber: AUTO_CAMPAIGN.dailyLimitPerNumber,
    },
    metrics: {
      toSendToday: status === 'active' ? Math.min(available, capacityToday) : 0,
      available,
      capacityToday,
      today: counts.today,
      total: counts.total,
    },
    activeAudios,
    numbers,
    warnings,
  };
}
