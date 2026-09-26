/**
 * Campanhas de automação: o gestor escolhe uma lista (e, se quiser, filtros), os números de WhatsApp, o horário de
 * trabalho, os dias da semana, as datas, o cooldown e o limite diário por número; o sistema entra sozinho nos leads
 * elegíveis, pelo mesmo executor das automações.
 *
 * Aqui ficam as ações do gestor (prévia, iniciar/agendar, editar, pausar, retomar, encerrar, consultar). Quem decide QUAL
 * lead entra, por QUAL número e QUANDO é `queue.ts`, chamado pelo job do scheduler; quem envia é `executor.ts`; quem
 * define quem é elegível é `campaign-audience.ts`; e a cota diária de contatos de cada número (manual + automático) é a de
 * `whatsapp/quota.ts`. A campanha guarda só o estado: nada fica em memória e nenhum lead é copiado.
 *
 * TODO o calendário é o de São Paulo (`America/Sao_Paulo`): datas, dias da semana, horário, cooldown, capacidade e
 * cota. O fuso do navegador nunca entra na conta.
 *
 * Limites e riscos (também em docs/DECISOES.md): o rodízio de números, o limite diário e a janela de horário
 * reduzem o volume por número, mas NÃO impedem que o WhatsApp restrinja um número. A Evolution API usa o
 * WhatsApp Web sem vínculo oficial e o envio em massa para quem não pediu contato pode violar os termos do WhatsApp.
 */
import { sql } from 'kysely';
import type {
  CampaignCalendar,
  CampaignCounts,
  CampaignDetail,
  CampaignInput,
  CampaignItem,
  CampaignNextSend,
  CampaignNumber,
  CampaignPreview,
  CampaignUpdateInput,
} from '../../../shared/api';
import { automationProblems, campaignEndLabel, formatClock, parseClock } from '../../../shared/automations';
import {
  type CampaignAudience,
  type CampaignFilters,
  type CampaignScheduleInfo,
  type CampaignStats,
  COOLDOWN_DEFAULT_HOURS,
  DEFAULT_DAYS,
  formatDays,
  normalizeDays,
  normalizeFilters,
} from '../../../shared/campaign-plan';
import type { AuthUser } from '../../auth/sessions';
import type { Db } from '../../db';
import type { AutomationCampaign } from '../../db/schema';
import { audit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { visibleNumber } from '../whatsapp/access';
import { effectiveLimit, instanceUsage } from '../whatsapp/quota';
import { publishCampaignChange } from '../whatsapp/realtime';
import {
  type AudienceConfig,
  audienceConfigOf,
  campaignAudienceSummary,
  countCampaignEligibleLeads,
} from './campaign-audience';
import { buildCalendar, type CapacityNumber, estimateDuration } from './capacity';
import { endCampaign } from './queue';
import { loadSteps, lockAutomation, stepDto } from './service';
import {
  dayAllowed,
  followUpSchedule,
  insideSchedule,
  nextScheduleOpening,
  type Schedule,
  scheduleOf,
  spDate,
  spTime,
  ymd,
} from './window';

const NOT_FOUND = 'Campanha não encontrada.';

/** Motivos de encerramento guardados em `automation_campaigns.end_reason`. */
export const END_REASON = { manual: 'encerrada_manualmente' } as const;

/** Depois de uma pausa: o que venceu enquanto isso sai um a cada tantos segundos, por número (não tudo de uma vez). */
export const RESUME_GAP_SECONDS = 60;

/** Quantos próximos envios o painel mostra. */
const NEXT_SENDS = 8;

const dateBr = (date: string): string => date.split('-').reverse().join('/');

// ---------- agenda ----------

/** O que a campanha está fazendo em relação ao calendário, e por quê (contas do servidor). */
export function scheduleInfo(
  row: Pick<
    AutomationCampaign,
    | 'status'
    | 'end_reason'
    | 'window_start_min'
    | 'window_end_min'
    | 'days_of_week'
    | 'start_date'
    | 'end_date'
  >,
  now: Date,
): CampaignScheduleInfo {
  const today = spDate(now);
  const schedule = scheduleOf(row);
  const info = (
    state: CampaignScheduleInfo['state'],
    nextOpening: Date | null,
    reason: string | null,
  ): CampaignScheduleInfo => ({
    state,
    nextOpening: nextOpening ? nextOpening.toISOString() : null,
    today,
    reason,
  });

  if (row.status === 'stopped' || row.status === 'finished') {
    return info('ended', null, campaignEndLabel(row.end_reason));
  }
  if (row.status === 'paused') {
    return info('waiting', null, 'Campanha pausada: nenhum lead novo entra e nada é enviado.');
  }
  if (schedule.endDate && today > schedule.endDate) {
    return info(
      'ended',
      null,
      `A data final (${dateBr(schedule.endDate)}) passou: nenhum primeiro contato novo sai.`,
    );
  }
  const next = nextScheduleOpening(now, schedule);
  if (!next) return info('ended', null, 'Não há mais dias de execução até a data final.');
  if (schedule.startDate && today < schedule.startDate) {
    return info('scheduled', next, `Agendada: começa em ${dateBr(schedule.startDate)}.`);
  }
  if (insideSchedule(now, schedule)) return info('running', now, null);
  if (!dayAllowed(today, schedule))
    return info('waiting', next, 'Hoje não é um dia de execução da campanha.');
  const minutes = spTime(now).minutes;
  return info(
    'waiting',
    next,
    minutes >= schedule.endMin
      ? `Fora do horário: a janela fechou às ${formatClock(schedule.endMin)}.`
      : `Antes do horário: a janela abre às ${formatClock(schedule.startMin)}.`,
  );
}

// ---------- leitura ----------

type CampaignRow = AutomationCampaign & { list_name: string | null; starter_name: string | null };

const withRefs = (db: Db) =>
  db
    .selectFrom('automation_campaigns as c')
    .leftJoin('lists as l', 'l.id', 'c.list_id')
    .leftJoin('users as u', 'u.id', 'c.started_by')
    .selectAll('c')
    .select(['l.name as list_name', 'u.name as starter_name']);

const emptyCounts = (): CampaignCounts => ({ total: 0, waiting: 0, completed: 0, cancelled: 0, failed: 0 });

async function countsFor(db: Db, campaignIds: number[]): Promise<Map<number, CampaignCounts>> {
  const byCampaign = new Map<number, CampaignCounts>(campaignIds.map((id) => [id, emptyCounts()]));
  if (!campaignIds.length) return byCampaign;
  const rows = await db
    .selectFrom('automation_runs')
    .select(['campaign_id', 'status'])
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('campaign_id', 'in', campaignIds)
    .groupBy(['campaign_id', 'status'])
    .execute();
  for (const row of rows) {
    const counts = row.campaign_id === null ? undefined : byCampaign.get(row.campaign_id);
    if (!counts) continue;
    const n = Number(row.n);
    counts.total += n;
    if (row.status === 'pending' || row.status === 'running') counts.waiting += n;
    else counts[row.status] += n;
  }
  return byCampaign;
}

function itemDto(row: CampaignRow, counts: CampaignCounts, now: Date): CampaignItem {
  return {
    id: row.id,
    automationId: row.automation_id,
    status: row.status,
    list: row.list_id ? { id: row.list_id, name: row.list_name ?? '—' } : null,
    instanceIds: row.instance_ids,
    windowStart: formatClock(row.window_start_min),
    windowEnd: formatClock(row.window_end_min),
    dailyLimitPerNumber: row.daily_limit,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    endReason: row.end_reason,
    startedBy: row.started_by ? { id: row.started_by, name: row.starter_name ?? '—' } : null,
    counts,
    startDate: ymd(row.start_date),
    endDate: row.end_date ? ymd(row.end_date) : null,
    daysOfWeek: row.days_of_week,
    cooldownHours: row.cooldown_hours,
    filters: row.filters,
    schedule: scheduleInfo(row, now),
  };
}

/**
 * Os números pedidos, na ordem em que foram escolhidos, com a situação e o uso de HOJE (dia de São Paulo) da cota de
 * contatos: manual + automático + incerto, do banco. Número excluído some. `dailyLimit` é o teto da campanha (no máximo 20).
 */
async function numbersView(db: Db, ids: number[], dailyLimit: number, now: Date): Promise<CampaignNumber[]> {
  if (!ids.length) return [];
  const rows = await db
    .selectFrom('wa_instances')
    .select(['id', 'name', 'nickname', 'phone_jid', 'status'])
    .where('id', 'in', ids)
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const limit = effectiveLimit(dailyLimit);
  const usage = await instanceUsage(db, ids, spDate(now), limit);
  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    const u = usage.get(id) as NonNullable<ReturnType<typeof usage.get>>;
    return [
      {
        id,
        label: r.nickname || r.name,
        phone: r.phone_jid ? (r.phone_jid.split('@')[0]?.split(':')[0] ?? null) : null,
        status: r.status,
        connected: r.status === 'open',
        dailyLimit: limit,
        manualToday: u.manual,
        automaticToday: u.automatic,
        uncertainToday: u.uncertain,
        usedToday: u.total,
        remainingToday: u.remaining,
        limitReached: u.limitReached,
      },
    ];
  });
}

/** Os números no formato da capacidade (a conta da capacidade é pura: `capacity.ts`). */
const asCapacity = (numbers: CampaignNumber[]): CapacityNumber[] =>
  numbers.map((n) => ({ connected: n.connected, remainingToday: n.remainingToday, limit: n.dailyLimit }));

/** Quantos contatos novos por dia os números conectados comportam (com o dia vazio). */
const capacityOf = (numbers: CampaignNumber[], dailyLimit: number) =>
  numbers.filter((n) => n.connected).length * effectiveLimit(dailyLimit);

/** Quantos contatos novos ainda cabem HOJE: só os números conectados e com vaga, contando o que já foi feito. */
const availableToday = (numbers: CampaignNumber[]) =>
  numbers.filter((n) => n.connected).reduce((sum, n) => sum + n.remainingToday, 0);

/**
 * Os próximos envios, do servidor (nenhuma agenda paralela na tela). O horário mostrado é o de verdade: se o horário
 * guardado caiu fora da agenda (fora da janela, dia não permitido, antes da data inicial), vira a próxima abertura.
 */
async function nextSendsOf(db: Db, row: AutomationCampaign, now: Date): Promise<CampaignNextSend[]> {
  const rows = await db
    .selectFrom('automation_runs as r')
    .innerJoin('leads as l', 'l.id', 'r.lead_id')
    .innerJoin('wa_instances as i', 'i.id', 'r.instance_id')
    .select([
      'r.id',
      'r.next_run_at',
      'r.current_step',
      'l.id as lead_id',
      'l.company',
      'l.name',
      'l.anonymized_at',
      'i.id as instance_id',
      'i.name as instance_name',
      'i.nickname',
    ])
    .where('r.campaign_id', '=', row.id)
    .where('r.status', '=', 'pending')
    .where('r.next_run_at', 'is not', null)
    .orderBy('r.next_run_at')
    .orderBy('r.id')
    .limit(NEXT_SENDS)
    .execute();
  const schedule = scheduleOf(row);
  const sends = rows.flatMap((r) => {
    if (!r.next_run_at) return [];
    const from = new Date(Math.max(r.next_run_at.getTime(), now.getTime()));
    const at = nextScheduleOpening(from, r.current_step > 1 ? followUpSchedule(schedule) : schedule);
    if (!at) return [];
    return [
      {
        runId: r.id,
        at: at.toISOString(),
        lead: {
          id: r.lead_id,
          label: r.anonymized_at ? 'Anonimizado' : r.company || r.name || `Lead ${r.lead_id}`,
        },
        instance: { id: r.instance_id, label: r.nickname || r.instance_name },
      },
    ];
  });
  return sends.sort((a, b) => a.at.localeCompare(b.at));
}

async function loadRow(db: Db, automationId: number, campaignId: number): Promise<CampaignRow> {
  const row = await withRefs(db)
    .where('c.id', '=', campaignId)
    .where('c.automation_id', '=', automationId)
    .executeTakeFirst();
  if (!row) throw notFound(NOT_FOUND);
  return row;
}

const isLive = (row: Pick<AutomationCampaign, 'status'>) =>
  row.status === 'active' || row.status === 'paused';

/** A campanha com o que a tela precisa: contadores, uso de cada número hoje, leads que faltam e próximos envios. */
export async function getCampaign(
  db: Db,
  automationId: number,
  campaignId: number,
  now = new Date(),
): Promise<CampaignDetail> {
  const row = await loadRow(db, automationId, campaignId);
  const counts = (await countsFor(db, [row.id])).get(row.id) ?? emptyCounts();
  const numbers = await numbersView(db, row.instance_ids, row.daily_limit, now);
  const live = isLive(row);
  const audience = audienceConfigOf(row);
  return {
    ...itemDto(row, counts, now),
    numbers,
    eligibleLeads: live && audience ? await countCampaignEligibleLeads(db, audience, now) : 0,
    dailyCapacity: capacityOf(numbers, row.daily_limit),
    availableToday: availableToday(numbers),
    nextSends: live ? await nextSendsOf(db, row, now) : [],
  };
}

/** As campanhas mais recentes da automação (a viva primeiro). */
export async function listCampaigns(
  db: Db,
  automationId: number,
  limit = 20,
  now = new Date(),
): Promise<CampaignItem[]> {
  const rows = await withRefs(db)
    .where('c.automation_id', '=', automationId)
    .orderBy(sql`(c.status IN ('active', 'paused'))`, 'desc')
    .orderBy('c.id', 'desc')
    .limit(limit)
    .execute();
  const counts = await countsFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => itemDto(row, counts.get(row.id) ?? emptyCounts(), now));
}

// ---------- conferências ----------

async function requireList(db: Db, listId: string): Promise<{ id: string; name: string }> {
  const list = await db
    .selectFrom('lists')
    .select(['id', 'name', 'archived_at'])
    .where('id', '=', listId)
    .executeTakeFirst();
  if (!list) throw notFound('Lista não encontrada.');
  if (list.archived_at) throw conflict('Esta lista está arquivada. Escolha outra.');
  return { id: list.id, name: list.name };
}

async function activeAudios(db: Db): Promise<number> {
  const r = await db
    .selectFrom('wa_audios')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('active', '=', true)
    .where('media_path', '<>', '')
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

function windowMinutes(input: { windowStart: string; windowEnd: string }): { start: number; end: number } {
  const start = parseClock(input.windowStart);
  const end = parseClock(input.windowEnd);
  if (start === null || end === null || start >= end || start > 1439 || end < 1) {
    throw conflict('O horário de trabalho é inválido: o fim precisa ser depois do início (HH:MM).');
  }
  return { start, end };
}

/** Os números escolhidos existem e a pessoa os vê (senão 404, como no restante do sistema). */
async function requireNumbers(db: Db, user: AuthUser, ids: number[]): Promise<void> {
  for (const id of ids) await visibleNumber(db, user, id);
}

/** Tudo o que define uma campanha, com os padrões aplicados (segunda a sexta, 24 h de cooldown, começa hoje). */
interface Settings {
  listId: string;
  instanceIds: number[];
  windowStart: string;
  windowEnd: string;
  dailyLimitPerNumber: number;
  startDate: string;
  endDate: string | null;
  daysOfWeek: number[];
  cooldownHours: number;
  filters: CampaignFilters;
}

function withDefaults(input: CampaignInput, now: Date): Settings {
  return {
    listId: input.listId,
    instanceIds: input.instanceIds,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    dailyLimitPerNumber: input.dailyLimitPerNumber,
    startDate: input.startDate ?? spDate(now),
    endDate: input.endDate ?? null,
    daysOfWeek: normalizeDays(input.daysOfWeek ?? DEFAULT_DAYS),
    cooldownHours: input.cooldownHours ?? COOLDOWN_DEFAULT_HOURS,
    filters: normalizeFilters(input.filters),
  };
}

function scheduleOfSettings(s: Settings): Schedule {
  const { start, end } = windowMinutes(s);
  return { startMin: start, endMin: end, days: s.daysOfWeek, startDate: s.startDate, endDate: s.endDate };
}

/** Uma data final que já passou não faz sentido: a campanha terminaria no primeiro ciclo. */
function requireFutureEnd(endDate: string | null, now: Date): void {
  if (endDate && endDate < spDate(now))
    throw conflict('A data final já passou. Escolha uma data de hoje em diante.');
}

/**
 * O que o gestor vê antes de iniciar ou agendar: o público (quantos entram e por que os outros ficam de fora), os números
 * com a cota de hoje, a capacidade real, a estimativa de duração e o calendário dos próximos dias. Não grava nada e não
 * carrega leads: o público é contado numa consulta agregada.
 */
export async function previewCampaign(
  db: Db,
  user: AuthUser,
  automationId: number,
  input: CampaignInput,
  now = new Date(),
): Promise<CampaignPreview> {
  const automation = await db
    .selectFrom('automations')
    .select(['id', 'name'])
    .where('id', '=', automationId)
    .executeTakeFirst();
  if (!automation) throw notFound('Automação não encontrada.');
  const list = await db
    .selectFrom('lists')
    .select(['id', 'name'])
    .where('id', '=', input.listId)
    .executeTakeFirst();
  if (!list) throw notFound('Lista não encontrada.');
  await requireNumbers(db, user, input.instanceIds);
  const settings = withDefaults(input, now);
  const schedule = scheduleOfSettings(settings);
  const config: AudienceConfig = {
    listId: list.id,
    automationId,
    campaignId: null,
    filters: settings.filters,
    cooldownHours: settings.cooldownHours,
  };
  const audience = await campaignAudienceSummary(db, config, now);
  const numbers = await numbersView(db, input.instanceIds, input.dailyLimitPerNumber, now);
  const capacity = asCapacity(numbers);
  return {
    list,
    automation,
    audience,
    estimate: estimateDuration(now, schedule, capacity, audience.eligible),
    calendar: buildCalendar(now, schedule, capacity, 14),
    schedule: scheduleInfo(
      {
        status: 'active',
        end_reason: null,
        window_start_min: schedule.startMin,
        window_end_min: schedule.endMin,
        days_of_week: [...schedule.days],
        start_date: settings.startDate as unknown as Date,
        end_date: settings.endDate as unknown as Date | null,
      },
      now,
    ),
    eligibleLeads: audience.eligible,
    numbers,
    connectedNumbers: numbers.filter((n) => n.connected).length,
    dailyCapacity: capacityOf(numbers, input.dailyLimitPerNumber),
    availableToday: availableToday(numbers),
    activeAudios: await activeAudios(db),
  };
}

/** A campanha viva (ativa, agendada ou pausada) desta automação, se houver. */
export async function liveCampaign(db: Db, automationId: number): Promise<{ id: number } | undefined> {
  return db
    .selectFrom('automation_campaigns')
    .select('id')
    .where('automation_id', '=', automationId)
    .where('status', 'in', ['active', 'paused'])
    .executeTakeFirst();
}

// ---------- ações ----------

/**
 * Inicia (ou agenda) a campanha. Exige: automação ativa e completa (com áudio ativo se alguma etapa sorteia), lista existente
 * e não arquivada, números que a pessoa vê e pelo menos um conectado agora, e pelo menos um lead elegível. Com data
 * inicial no futuro, a campanha fica AGENDADA e nada é enviado antes. Fora do horário, "iniciar agora" não envia: a
 * campanha espera a próxima janela válida. Só há uma campanha viva por automação (o índice único garante, mesmo com dois
 * cliques ao mesmo tempo).
 */
export async function startCampaign(
  db: Db,
  user: AuthUser,
  automationId: number,
  input: CampaignInput,
  ip: string | null,
  now = new Date(),
): Promise<CampaignDetail> {
  const settings = withDefaults(input, now);
  const schedule = scheduleOfSettings(settings);
  requireFutureEnd(settings.endDate, now);
  const id = await db.transaction().execute(async (trx) => {
    const automation = await lockAutomation(trx, automationId);
    if (automation.status === 'archived')
      throw conflict('Uma automação arquivada não pode iniciar campanha.');
    if (automation.status !== 'active')
      throw conflict('A automação precisa estar ativa para iniciar uma campanha.');
    const steps = (await loadSteps(trx, [automationId])).get(automationId) ?? [];
    const problems = automationProblems(steps.map(stepDto));
    if (problems.length)
      throw conflict(`A automação tem etapa incompleta. ${problems.join(' ')}`, { problems });
    if (
      steps.some((s) => s.action_type === 'send_audio' && s.audio_mode === 'random') &&
      (await activeAudios(trx)) === 0
    ) {
      throw conflict('Uma etapa sorteia áudio e não há nenhum áudio ativo na biblioteca.');
    }
    if (await liveCampaign(trx, automationId)) {
      throw conflict(
        'Esta automação já tem uma campanha em andamento. Pause ou encerre antes de iniciar outra.',
      );
    }

    const list = await requireList(trx, settings.listId);
    await requireNumbers(trx, user, settings.instanceIds);
    const numbers = await numbersView(trx, settings.instanceIds, settings.dailyLimitPerNumber, now);
    if (!numbers.some((n) => n.connected)) {
      throw conflict('Nenhum dos números escolhidos está conectado agora. Conecte pelo menos um.');
    }
    const eligible = await countCampaignEligibleLeads(
      trx,
      {
        listId: list.id,
        automationId,
        campaignId: null,
        filters: settings.filters,
        cooldownHours: settings.cooldownHours,
      },
      now,
    );
    if (eligible === 0) throw conflict('Não há leads elegíveis nesta lista (com os filtros escolhidos).');

    const created = await trx
      .insertInto('automation_campaigns')
      .values({
        automation_id: automationId,
        list_id: list.id,
        // O `int[]` do PostgreSQL recebe um array comum do JavaScript.
        instance_ids: settings.instanceIds,
        window_start_min: schedule.startMin,
        window_end_min: schedule.endMin,
        daily_limit: settings.dailyLimitPerNumber,
        start_date: settings.startDate,
        end_date: settings.endDate,
        days_of_week: settings.daysOfWeek,
        cooldown_hours: settings.cooldownHours,
        // Coluna JSONB: grava-se como texto JSON.
        filters: JSON.stringify(settings.filters),
        started_by: user.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch((error: { code?: string; constraint?: string }) => {
        if (error.code === '23505' && error.constraint === 'automation_campaigns_live_key') {
          throw conflict('Esta automação já tem uma campanha em andamento.');
        }
        throw error;
      });
    await audit(trx, {
      userId: user.id,
      action: settings.startDate > spDate(now) ? 'agendou_campanha' : 'iniciou_campanha',
      entity: 'automacao',
      entityId: automationId,
      details: {
        campanha: created.id,
        lista: list.name,
        numeros: settings.instanceIds,
        janela: `${formatClock(schedule.startMin)}–${formatClock(schedule.endMin)}`,
        dias: formatDays(settings.daysOfWeek),
        inicio: settings.startDate,
        fim: settings.endDate,
        cooldown_horas: settings.cooldownHours,
        filtros: settings.filters,
        limite_por_numero: settings.dailyLimitPerNumber,
        leads_elegiveis: eligible,
      },
      ip,
    });
    return created.id;
  });
  void publishCampaignChange([id]);
  return getCampaign(db, automationId, id, now);
}

/** Trava a linha da campanha até o fim da transação (pausar, retomar, editar e encerrar não se atropelam). */
async function lockCampaign(db: Db, automationId: number, campaignId: number): Promise<AutomationCampaign> {
  const row = await db
    .selectFrom('automation_campaigns')
    .selectAll()
    .where('id', '=', campaignId)
    .where('automation_id', '=', automationId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw notFound(NOT_FOUND);
  return row;
}

const ENDED_MESSAGE = 'A campanha já foi encerrada.';

/**
 * Altera uma campanha ativa, agendada ou pausada: números, horário, dias, datas, cooldown, filtros, limite (e a lista, só
 * enquanto ainda nenhum lead entrou). Vale para os próximos leads: o que já foi enviado e o histórico não mudam.
 */
export async function updateCampaign(
  db: Db,
  user: AuthUser,
  automationId: number,
  campaignId: number,
  input: CampaignUpdateInput,
  ip: string | null,
  now = new Date(),
): Promise<CampaignDetail> {
  await db.transaction().execute(async (trx) => {
    const current = await lockCampaign(trx, automationId, campaignId);
    if (!isLive(current)) throw conflict(ENDED_MESSAGE);

    const merged: Settings = {
      listId: input.listId ?? current.list_id ?? '',
      instanceIds: input.instanceIds ?? current.instance_ids,
      windowStart: input.windowStart ?? formatClock(current.window_start_min),
      windowEnd: input.windowEnd ?? formatClock(current.window_end_min),
      dailyLimitPerNumber: input.dailyLimitPerNumber ?? current.daily_limit,
      startDate: input.startDate ?? ymd(current.start_date),
      endDate:
        input.endDate === undefined ? (current.end_date ? ymd(current.end_date) : null) : input.endDate,
      daysOfWeek: normalizeDays(input.daysOfWeek ?? current.days_of_week),
      cooldownHours: input.cooldownHours ?? current.cooldown_hours,
      filters: input.filters === undefined ? current.filters : normalizeFilters(input.filters),
    };
    if (!merged.listId) throw conflict('Escolha a lista da campanha.');
    const schedule = scheduleOfSettings(merged);
    if (merged.endDate && merged.endDate < merged.startDate) {
      throw conflict('A data final não pode ser antes da inicial.');
    }
    if (input.endDate !== undefined) requireFutureEnd(merged.endDate, now);

    const started = (await countsFor(trx, [campaignId])).get(campaignId)?.total ?? 0;
    if (started > 0 && input.listId !== undefined && input.listId !== current.list_id) {
      throw conflict('A lista só pode ser trocada antes de qualquer lead entrar na campanha.');
    }
    if (started > 0 && input.startDate !== undefined && input.startDate !== ymd(current.start_date)) {
      throw conflict('A data inicial só pode ser alterada antes de qualquer lead entrar na campanha.');
    }
    if (input.listId !== undefined && input.listId !== current.list_id) await requireList(trx, input.listId);
    if (input.instanceIds !== undefined) {
      await requireNumbers(trx, user, input.instanceIds);
      const numbers = await numbersView(trx, input.instanceIds, merged.dailyLimitPerNumber, now);
      if (!numbers.length) throw conflict('Escolha pelo menos um número que exista.');
    }

    await trx
      .updateTable('automation_campaigns')
      .set({
        list_id: merged.listId,
        instance_ids: merged.instanceIds,
        window_start_min: schedule.startMin,
        window_end_min: schedule.endMin,
        daily_limit: merged.dailyLimitPerNumber,
        start_date: merged.startDate,
        end_date: merged.endDate,
        days_of_week: merged.daysOfWeek,
        cooldown_hours: merged.cooldownHours,
        filters: JSON.stringify(merged.filters),
        updated_at: sql`now()`,
      })
      .where('id', '=', campaignId)
      .execute();
    await audit(trx, {
      userId: user.id,
      action: 'alterou_campanha',
      entity: 'automacao',
      entityId: automationId,
      details: { campanha: campaignId, campos: Object.keys(input) },
      ip,
    });
  });
  void publishCampaignChange([campaignId]);
  return getCampaign(db, automationId, campaignId, now);
}

/**
 * Pausa: nenhum lead novo é reservado, nenhum primeiro contato sai e as etapas seguintes esperam. As participações, o
 * histórico, a cota do dia e a agenda seguem gravados; ao retomar, continua de onde parou.
 */
export async function pauseCampaign(
  db: Db,
  user: AuthUser,
  automationId: number,
  campaignId: number,
  ip: string | null,
): Promise<CampaignDetail> {
  await db.transaction().execute(async (trx) => {
    const campaign = await lockCampaign(trx, automationId, campaignId);
    if (campaign.status === 'paused') throw conflict('A campanha já está pausada.');
    if (campaign.status !== 'active') throw conflict(ENDED_MESSAGE);
    await trx
      .updateTable('automation_campaigns')
      .set({ status: 'paused', updated_at: sql`now()` })
      .where('id', '=', campaignId)
      .execute();
    await audit(trx, {
      userId: user.id,
      action: 'pausou_campanha',
      entity: 'automacao',
      entityId: automationId,
      details: { campanha: campaignId },
      ip,
    });
  });
  void publishCampaignChange([campaignId]);
  return getCampaign(db, automationId, campaignId);
}

/**
 * Retoma de onde parou (sem reenviar nada e sem repetir lead). Os envios que venceram durante a pausa não saem
 * todos de uma vez: são reagendados, um por minuto por número.
 */
export async function resumeCampaign(
  db: Db,
  user: AuthUser,
  automationId: number,
  campaignId: number,
  ip: string | null,
  now = new Date(),
): Promise<CampaignDetail> {
  await db.transaction().execute(async (trx) => {
    // Ordem das travas: automação, depois campanha (a mesma de arquivar, para nunca travar um no outro).
    const automation = await lockAutomation(trx, automationId);
    const campaign = await lockCampaign(trx, automationId, campaignId);
    if (campaign.status === 'active') throw conflict('A campanha já está ativa.');
    if (campaign.status !== 'paused') throw conflict(ENDED_MESSAGE);
    if (automation.status !== 'active') {
      throw conflict('A automação precisa estar ativa para retomar a campanha.');
    }
    await trx
      .updateTable('automation_campaigns')
      .set({ status: 'active', updated_at: sql`now()` })
      .where('id', '=', campaignId)
      .execute();
    const respaced = await sql`
      WITH overdue AS (
        SELECT id, row_number() OVER (PARTITION BY instance_id ORDER BY next_run_at, id) AS n
        FROM automation_runs
        WHERE campaign_id = ${campaignId} AND status = 'pending' AND next_run_at < ${now}
      )
      UPDATE automation_runs r
      SET next_run_at = ${now}::timestamptz + make_interval(secs => ((o.n - 1) * ${RESUME_GAP_SECONDS})::double precision),
        updated_at = now()
      FROM overdue o
      WHERE r.id = o.id`.execute(trx);
    await audit(trx, {
      userId: user.id,
      action: 'retomou_campanha',
      entity: 'automacao',
      entityId: automationId,
      details: { campanha: campaignId, envios_reagendados: Number(respaced.numAffectedRows ?? 0) },
      ip,
    });
  });
  void publishCampaignChange([campaignId]);
  return getCampaign(db, automationId, campaignId, now);
}

/**
 * Encerra de vez: cancela as participações que ainda não terminaram (inclusive as etapas seguintes de quem já
 * recebeu a primeira mensagem) e mantém todo o histórico e as mensagens. Uma campanha encerrada não volta.
 */
export async function stopCampaign(
  db: Db,
  user: AuthUser,
  automationId: number,
  campaignId: number,
  ip: string | null,
): Promise<CampaignDetail> {
  const row = await loadRow(db, automationId, campaignId);
  if (row.status === 'stopped' || row.status === 'finished') throw conflict(ENDED_MESSAGE);
  const ended = await endCampaign(db, campaignId, 'stopped', END_REASON.manual, user.id, ip);
  if (!ended) throw conflict(ENDED_MESSAGE); // outra pessoa encerrou entre a leitura e agora
  void publishCampaignChange([campaignId]);
  return getCampaign(db, automationId, campaignId);
}

// ---------- painel operacional ----------

/** Frases que explicam, em palavras, por que a campanha pode estar parada. Tudo vem do servidor. */
function explain(o: {
  row: CampaignRow;
  schedule: CampaignScheduleInfo;
  audience: CampaignAudience;
  numbers: CampaignNumber[];
  counts: CampaignCounts;
  automationStatus: string | null;
}): string[] {
  const out: string[] = [];
  if (o.schedule.reason) out.push(o.schedule.reason);
  if (o.automationStatus === 'paused')
    out.push('A automação está pausada: a campanha espera até ela ser ativada.');
  if (isLive(o.row)) {
    const connected = o.numbers.filter((n) => n.connected);
    if (!o.numbers.length) out.push('Nenhum dos números da campanha existe mais.');
    else if (!connected.length) out.push('Nenhum número da campanha está conectado agora.');
    else if (connected.every((n) => n.limitReached)) {
      out.push(
        'Todos os números conectados atingiram a cota de hoje (20 contatos): o resto fica para o próximo dia.',
      );
    }
    const disconnected = o.numbers.length - connected.length;
    if (connected.length && disconnected > 0) {
      out.push(`${disconnected} número(s) desconectado(s): ficam fora do rodízio até reconectar.`);
    }
    if (o.audience.eligible === 0 && o.counts.waiting === 0) {
      out.push('Não há mais leads elegíveis: a campanha termina sozinha.');
    }
  }
  return out;
}

/**
 * Contadores e explicações de uma campanha: o público (agregado), o que já foi processado e por que ela pode estar parada.
 * Uma consulta agregada para o público e uma para os motivos: nada é carregado lead a lead.
 */
export async function campaignStats(
  db: Db,
  automationId: number,
  campaignId: number,
  now = new Date(),
): Promise<CampaignStats> {
  const row = await loadRow(db, automationId, campaignId);
  const counts = (await countsFor(db, [row.id])).get(row.id) ?? emptyCounts();
  const numbers = await numbersView(db, row.instance_ids, row.daily_limit, now);
  const config = audienceConfigOf(row);
  const audience: CampaignAudience = config
    ? await campaignAudienceSummary(db, config, now)
    : {
        total: 0,
        eligible: 0,
        blocked: 0,
        noWhatsapp: 0,
        participated: 0,
        inCooldown: 0,
        anonymized: 0,
        filteredOut: 0,
      };
  const reasons = await sql<{ no_whatsapp: number; blocked: number }>`
    SELECT
      count(*) FILTER (WHERE status = 'failed' AND cancel_reason = 'sem_whatsapp') AS no_whatsapp,
      count(*) FILTER (WHERE status = 'cancelled' AND cancel_reason = 'lead_bloqueado') AS blocked
    FROM automation_runs WHERE campaign_id = ${campaignId}`.execute(db);
  const automation = await db
    .selectFrom('automations')
    .select('status')
    .where('id', '=', automationId)
    .executeTakeFirst();
  const schedule = scheduleInfo(row, now);
  return {
    audience,
    processed: counts.total,
    waiting: counts.waiting,
    completed: counts.completed,
    cancelled: counts.cancelled,
    failed: counts.failed,
    noWhatsapp: Number(reasons.rows[0]?.no_whatsapp ?? 0),
    blocked: Number(reasons.rows[0]?.blocked ?? 0),
    numbersFull: numbers.filter((n) => n.limitReached).length,
    numbersDisconnected: numbers.filter((n) => !n.connected).length,
    numbers: numbers.length,
    explain: explain({
      row,
      schedule,
      audience,
      numbers,
      counts,
      automationStatus: automation?.status ?? null,
    }),
    schedule,
  };
}

/** Os próximos dias da campanha (quando executa e quantos contatos cabem) e a estimativa de duração. */
export async function campaignCalendar(
  db: Db,
  automationId: number,
  campaignId: number,
  days = 14,
  now = new Date(),
): Promise<CampaignCalendar> {
  const row = await loadRow(db, automationId, campaignId);
  const numbers = await numbersView(db, row.instance_ids, row.daily_limit, now);
  const config = audienceConfigOf(row);
  const eligible = config && isLive(row) ? await countCampaignEligibleLeads(db, config, now) : 0;
  const schedule = scheduleOf(row);
  const capacity = asCapacity(numbers);
  return {
    days: buildCalendar(now, schedule, capacity, days),
    estimate: estimateDuration(now, schedule, capacity, eligible),
  };
}
