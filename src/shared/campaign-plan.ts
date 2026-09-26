/**
 * Agenda e público de uma campanha: dias da semana, filtros de leads, cooldown e os formatos de prévia, capacidade,
 * estimativa e calendário. Tudo com o calendário de SÃO PAULO (`America/Sao_Paulo`): nada aqui usa o fuso do navegador.
 * O servidor é a autoridade; a interface só monta e mostra.
 */
import type { ResultId } from './results';

// ---------- dias da semana (ISO: 1 = segunda ... 7 = domingo) ----------

export const WEEKDAYS = [
  { iso: 1, short: 'Seg', long: 'Segunda' },
  { iso: 2, short: 'Ter', long: 'Terça' },
  { iso: 3, short: 'Qua', long: 'Quarta' },
  { iso: 4, short: 'Qui', long: 'Quinta' },
  { iso: 5, short: 'Sex', long: 'Sexta' },
  { iso: 6, short: 'Sáb', long: 'Sábado' },
  { iso: 7, short: 'Dom', long: 'Domingo' },
] as const;

/** Segunda a sexta: o padrão de toda campanha nova. */
export const DEFAULT_DAYS: readonly number[] = [1, 2, 3, 4, 5];
export const ALL_DAYS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];

export const weekdayLong = (iso: number): string => WEEKDAYS.find((d) => d.iso === iso)?.long ?? '';

/** Dias em ordem, sem repetir, só de 1 a 7. */
export function normalizeDays(days: readonly number[]): number[] {
  return [...new Set(days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);
}

/** "Seg–Sex", "Todos os dias", "Seg, Qua e Sex"... */
export function formatDays(days: readonly number[]): string {
  const list = normalizeDays(days);
  if (!list.length) return 'Nenhum dia';
  if (list.length === 7) return 'Todos os dias';
  const short = (iso: number) => WEEKDAYS.find((d) => d.iso === iso)?.short ?? '';
  const first = list[0] as number;
  const last = list[list.length - 1] as number;
  if (list.length > 2 && last - first === list.length - 1) return `${short(first)}–${short(last)}`;
  const names = list.map(short);
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

// ---------- filtros do público ----------

/** Situações de lead que fazem sentido para um PRIMEIRO contato (bloqueado nunca entra). */
export const CAMPAIGN_LEAD_STATUSES = ['pendente', 'chamado'] as const;
export type CampaignLeadStatus = (typeof CAMPAIGN_LEAD_STATUSES)[number];

export const CAMPAIGN_PHONE_TYPES = ['movel', 'fixo'] as const;
export type CampaignPhoneType = (typeof CAMPAIGN_PHONE_TYPES)[number];

export const CALLED_BEFORE_OPTIONS = ['any', 'never', 'already'] as const;
export type CalledBefore = (typeof CALLED_BEFORE_OPTIONS)[number];

/**
 * Filtros opcionais sobre a lista (guardados em `automation_campaigns.filters`, JSONB). Só usam dados que já existem no
 * lead. Campo ausente = sem filtro. A lista continua sendo a base do público.
 */
export interface CampaignFilters {
  /** DDDs (ex.: "41"). */
  ddd?: string[];
  /** Situação do lead. Ausente = só "pendente" (a fila livre). */
  status?: CampaignLeadStatus[];
  /** Resultado do lead (os mesmos `ResultId` do sistema). */
  result?: ResultId[];
  /** Tipo do telefone. Ausente = só celular ou sem tipo conhecido (telefone fixo raramente tem WhatsApp). */
  phoneType?: CampaignPhoneType[];
  /** Chamado antes? "never" = nunca chamado; "already" = já foi chamado; "any" = tanto faz. */
  calledBefore?: CalledBefore;
}

export const MAX_FILTER_DDDS = 30;

/** Tira do filtro tudo o que é vazio ou o padrão, para o que fica guardado ser só o que restringe de verdade. */
export function normalizeFilters(input: CampaignFilters | null | undefined): CampaignFilters {
  const out: CampaignFilters = {};
  const ddd = [...new Set((input?.ddd ?? []).map((d) => d.trim()).filter((d) => /^\d{2}$/.test(d)))].sort();
  if (ddd.length) out.ddd = ddd;
  const status = CAMPAIGN_LEAD_STATUSES.filter((s) => input?.status?.includes(s));
  if (status.length) out.status = [...status];
  const result = [...new Set(input?.result ?? [])];
  if (result.length) out.result = result;
  const phoneType = CAMPAIGN_PHONE_TYPES.filter((t) => input?.phoneType?.includes(t));
  if (phoneType.length) out.phoneType = [...phoneType];
  if (input?.calledBefore && input.calledBefore !== 'any') out.calledBefore = input.calledBefore;
  return out;
}

export const STATUS_FILTER_LABELS: Record<CampaignLeadStatus, string> = {
  pendente: 'Pendente (fila livre)',
  chamado: 'Já chamado',
};
export const PHONE_TYPE_LABELS: Record<CampaignPhoneType, string> = { movel: 'Celular', fixo: 'Fixo' };
export const CALLED_BEFORE_LABELS: Record<CalledBefore, string> = {
  any: 'Tanto faz',
  never: 'Nunca chamado',
  already: 'Já chamado',
};

// ---------- cooldown ----------

export const COOLDOWN_DEFAULT_HOURS = 24;
export const COOLDOWN_MAX_HOURS = 720;

// ---------- prévia, capacidade, estimativa e calendário ----------

/**
 * O público da campanha, contado pelo servidor (uma consulta agregada; nenhum lead é carregado). Os grupos NÃO são
 * exclusivos entre si: um lead pode estar, por exemplo, em cooldown e também fora do filtro. `eligible` é o que de
 * fato pode receber um primeiro contato agora.
 */
export interface CampaignAudience {
  /** Leads na lista. */
  total: number;
  eligible: number;
  /** Em "não contatar" (telefone bloqueado ou lead bloqueado). */
  blocked: number;
  /** Resultado "Sem WhatsApp". */
  noWhatsapp: number;
  /** Já participaram desta automação (ou desta campanha). */
  participated: number;
  /** Em cooldown: receberam um primeiro contato automático há menos que o cooldown. */
  inCooldown: number;
  anonymized: number;
  /** Fora dos filtros escolhidos. */
  filteredOut: number;
}

export type CalendarDayState = 'runs' | 'not_allowed' | 'before_start' | 'after_end' | 'window_closed';

export interface CalendarDay {
  /** AAAA-MM-DD em São Paulo. */
  date: string;
  /** 1 (segunda) a 7 (domingo). */
  weekday: number;
  state: CalendarDayState;
  /** Contatos novos que cabem neste dia (0 quando não executa). */
  capacity: number;
}

export type EstimateStatus = 'ok' | 'no_audience' | 'no_capacity' | 'beyond_end_date' | 'too_long';

/** Estimativa APROXIMADA de quanto tempo o público leva para ser atendido. Nunca é uma data garantida. */
export interface CampaignEstimate {
  status: EstimateStatus;
  eligible: number;
  connectedNumbers: number;
  /** Quanto ainda cabe hoje (já descontados os contatos manuais e automáticos de hoje). */
  capacityToday: number;
  /** Capacidade de um dia cheio: números conectados x limite (com o dia vazio). */
  capacityPerDay: number;
  /** Dias em que a campanha executa até acabar o público (ou até a data final). */
  runDays: number;
  /** Primeiro e último dia de execução previstos (AAAA-MM-DD). */
  firstDay: string | null;
  lastDay: string | null;
  /** Leads que sobrariam quando chegar a data final (0 se der tempo). */
  leftover: number;
}

/** Quando a campanha executa e o que ela está esperando. */
export type CampaignScheduleState = 'scheduled' | 'running' | 'waiting' | 'ended';

export interface CampaignScheduleInfo {
  state: CampaignScheduleState;
  /** Próximo instante em que pode enviar (agora, se já estiver dentro; vazio se não vai mais executar). */
  nextOpening: string | null;
  /** Hoje em São Paulo (AAAA-MM-DD). */
  today: string;
  /** Por que está esperando, em palavras (vem do servidor). */
  reason: string | null;
}

/** Números para o painel "por que está parada?". */
export interface CampaignStats {
  audience: CampaignAudience;
  /** Leads que já entraram (uma participação cada). */
  processed: number;
  waiting: number;
  completed: number;
  cancelled: number;
  failed: number;
  /** Participações que falharam por o telefone não ter WhatsApp. */
  noWhatsapp: number;
  /** Participações canceladas porque o lead entrou em "não contatar". */
  blocked: number;
  /** Números da campanha que atingiram a cota de hoje. */
  numbersFull: number;
  /** Números da campanha desconectados agora. */
  numbersDisconnected: number;
  numbers: number;
  /** Frases que explicam por que a campanha pode estar parada (do servidor). */
  explain: string[];
  schedule: CampaignScheduleInfo;
}
