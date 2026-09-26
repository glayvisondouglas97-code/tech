/**
 * Formulário da campanha: o estado dos campos, a conversão para o corpo da API e a descrição em palavras. Aqui só se monta
 * e se confere o que a pessoa digitou; quem decide (elegibilidade, capacidade, agenda, cota) é sempre o servidor.
 */
import type { CampaignDetail, CampaignInput, CampaignItem, CampaignUpdateInput } from '../../shared/api';
import {
  CAMPAIGN_DEFAULTS,
  CAMPAIGN_MAX_DAILY_LIMIT,
  CAMPAIGN_MAX_NUMBERS,
  parseClock,
} from '../../shared/automations';
import {
  CALLED_BEFORE_LABELS,
  type CalledBefore,
  type CampaignEstimate,
  type CampaignFilters,
  type CampaignLeadStatus,
  type CampaignPhoneType,
  COOLDOWN_DEFAULT_HOURS,
  COOLDOWN_MAX_HOURS,
  DEFAULT_DAYS,
  formatDays,
  MAX_FILTER_DDDS,
  normalizeDays,
  normalizeFilters,
  PHONE_TYPE_LABELS,
  STATUS_FILTER_LABELS,
} from '../../shared/campaign-plan';
import { type ResultId, resultLabel } from '../../shared/results';
import { fmtYmd, ymdSP } from './format';

export interface CampaignFormState {
  listId: string;
  numbers: number[];
  windowStart: string;
  windowEnd: string;
  limitText: string;
  days: number[];
  /** "now" = Iniciar agora (hoje, dentro do horário; fora dele espera a próxima abertura). "scheduled" = Agendar campanha. */
  when: 'now' | 'scheduled';
  startDate: string;
  /** Vazio = sem data final. */
  endDate: string;
  cooldownText: string;
  dddText: string;
  status: CampaignLeadStatus[];
  results: ResultId[];
  phoneTypes: CampaignPhoneType[];
  calledBefore: CalledBefore;
}

export const initialForm = (): CampaignFormState => ({
  listId: '',
  numbers: [],
  windowStart: CAMPAIGN_DEFAULTS.windowStart,
  windowEnd: CAMPAIGN_DEFAULTS.windowEnd,
  limitText: String(CAMPAIGN_DEFAULTS.dailyLimitPerNumber),
  days: [...DEFAULT_DAYS],
  when: 'now',
  startDate: '',
  endDate: '',
  cooldownText: String(COOLDOWN_DEFAULT_HOURS),
  dddText: '',
  status: ['pendente'],
  results: [],
  phoneTypes: [],
  calledBefore: 'any',
});

/** A campanha que já existe, de volta para o formulário (editar). */
export function formFromCampaign(c: CampaignDetail | CampaignItem): CampaignFormState {
  const f = c.filters;
  return {
    listId: c.list?.id ?? '',
    numbers: [...c.instanceIds],
    windowStart: c.windowStart,
    windowEnd: c.windowEnd,
    limitText: String(c.dailyLimitPerNumber),
    days: [...c.daysOfWeek],
    when: c.startDate > ymdSP() ? 'scheduled' : 'now',
    startDate: c.startDate,
    endDate: c.endDate ?? '',
    cooldownText: String(c.cooldownHours),
    dddText: (f.ddd ?? []).join(', '),
    status: f.status?.length ? [...f.status] : ['pendente'],
    results: [...(f.result ?? [])],
    phoneTypes: [...(f.phoneType ?? [])],
    calledBefore: f.calledBefore ?? 'any',
  };
}

/** Os DDDs digitados ("41, 42 43"): os válidos (2 dígitos) e o que sobrou de errado. */
export function parseDdds(text: string): { ddds: string[]; invalid: string[] } {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const ddds = [...new Set(parts.filter((p) => /^\d{2}$/.test(p)))];
  const invalid = parts.filter((p) => !/^\d{2}$/.test(p));
  return { ddds, invalid };
}

/** Os filtros do formulário no formato da API (só o que restringe de verdade). */
export function filtersOf(f: CampaignFormState): CampaignFilters {
  const onlyPending = f.status.length === 1 && f.status[0] === 'pendente';
  return normalizeFilters({
    ddd: parseDdds(f.dddText).ddds,
    status: onlyPending || f.status.length === 0 ? undefined : f.status,
    result: f.results,
    phoneType: f.phoneTypes,
    calledBefore: f.calledBefore,
  });
}

const intOf = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

/** O que impede de seguir (em palavras). Lista vazia = pode. `today` é o dia de hoje em São Paulo. */
export function formProblems(f: CampaignFormState, today = ymdSP()): string[] {
  const out: string[] = [];
  if (!f.listId) out.push('Escolha a lista.');
  if (f.numbers.length === 0) out.push('Escolha pelo menos um número.');
  if (f.numbers.length > CAMPAIGN_MAX_NUMBERS) out.push(`Escolha no máximo ${CAMPAIGN_MAX_NUMBERS} números.`);
  const start = parseClock(f.windowStart);
  const end = parseClock(f.windowEnd);
  if (start === null || end === null || start >= end) {
    out.push('O fim do horário de trabalho precisa ser depois do início.');
  }
  const limit = intOf(f.limitText);
  if (limit === null || limit < 1 || limit > CAMPAIGN_MAX_DAILY_LIMIT) {
    out.push(`O limite por número vai de 1 a ${CAMPAIGN_MAX_DAILY_LIMIT} contatos por dia.`);
  }
  if (normalizeDays(f.days).length === 0) out.push('Escolha pelo menos um dia da semana.');
  const cooldown = intOf(f.cooldownText);
  if (cooldown === null || cooldown > COOLDOWN_MAX_HOURS) {
    out.push(`O cooldown vai de 0 a ${COOLDOWN_MAX_HOURS} horas (0 = sem cooldown).`);
  }
  const { ddds, invalid } = parseDdds(f.dddText);
  if (invalid.length) out.push(`DDD inválido: ${invalid.join(', ')}. Use dois números, como 41.`);
  if (ddds.length > MAX_FILTER_DDDS) out.push(`Use no máximo ${MAX_FILTER_DDDS} DDDs.`);
  if (f.when === 'scheduled') {
    if (!f.startDate) out.push('Escolha a data de início da campanha agendada.');
    else if (f.startDate <= today)
      out.push('A data de início precisa ser depois de hoje. Para começar hoje, use "Iniciar agora".');
  }
  if (f.endDate) {
    const first = f.when === 'scheduled' && f.startDate ? f.startDate : today;
    if (f.endDate < today) out.push('A data final já passou.');
    else if (f.endDate < first) out.push('A data final não pode ser antes da data de início.');
  }
  return out;
}

/** O corpo da API (prévia, iniciar, agendar). Devolve null se o formulário ainda tem problema. */
export function formToInput(f: CampaignFormState, today = ymdSP()): CampaignInput | null {
  if (formProblems(f, today).length) return null;
  const limit = intOf(f.limitText) as number;
  const filters = filtersOf(f);
  return {
    listId: f.listId,
    instanceIds: f.numbers,
    windowStart: f.windowStart,
    windowEnd: f.windowEnd,
    dailyLimitPerNumber: limit,
    startDate: f.when === 'scheduled' ? f.startDate : today,
    endDate: f.endDate || null,
    daysOfWeek: normalizeDays(f.days),
    cooldownHours: intOf(f.cooldownText) as number,
    filters,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Só o que mudou em relação à campanha original (editar não mexe no resto). */
export function changesFrom(original: CampaignFormState, next: CampaignFormState): CampaignUpdateInput {
  const input = formToInput(next);
  if (!input) return {};
  const out: CampaignUpdateInput = {};
  if (original.listId !== next.listId) out.listId = input.listId;
  if (!same(original.numbers, next.numbers)) out.instanceIds = input.instanceIds;
  if (original.windowStart !== next.windowStart) out.windowStart = input.windowStart;
  if (original.windowEnd !== next.windowEnd) out.windowEnd = input.windowEnd;
  if (original.limitText.trim() !== next.limitText.trim())
    out.dailyLimitPerNumber = input.dailyLimitPerNumber;
  if (!same(normalizeDays(original.days), normalizeDays(next.days))) out.daysOfWeek = input.daysOfWeek;
  if (original.startDate !== next.startDate && next.when === 'scheduled') out.startDate = next.startDate;
  if (original.endDate !== next.endDate) out.endDate = input.endDate;
  if (original.cooldownText.trim() !== next.cooldownText.trim()) out.cooldownHours = input.cooldownHours;
  if (!same(filtersOf(original), filtersOf(next))) out.filters = filtersOf(next);
  return out;
}

/** Os filtros em frases curtas (o resumo final e o painel usam). Sem nenhum filtro: lista vazia. */
export function describeFilters(filters: CampaignFilters): string[] {
  const out: string[] = [];
  if (filters.ddd?.length) out.push(`DDD ${filters.ddd.join(', ')}`);
  if (filters.status?.length)
    out.push(`Situação: ${filters.status.map((s) => STATUS_FILTER_LABELS[s]).join(', ')}`);
  if (filters.result?.length) out.push(`Resultado: ${filters.result.map((r) => resultLabel(r)).join(', ')}`);
  if (filters.phoneType?.length) {
    out.push(`Telefone: ${filters.phoneType.map((t) => PHONE_TYPE_LABELS[t]).join(' e ')}`);
  }
  if (filters.calledBefore) out.push(`Chamado antes: ${CALLED_BEFORE_LABELS[filters.calledBefore]}`);
  return out;
}

/** "Seg–Sex, 10:00 às 16:00" */
export const describeAgenda = (days: readonly number[], start: string, end: string) =>
  `${formatDays(days)}, ${start} às ${end}`;

/** "01/10/2026 a 31/10/2026", "a partir de 01/10/2026" ou "sem data final". */
export function describePeriod(startDate: string, endDate: string | null): string {
  if (!endDate) return `a partir de ${fmtYmd(startDate)} · sem data final`;
  return `${fmtYmd(startDate)} a ${fmtYmd(endDate)}`;
}

const dias = (n: number) => `${n} ${n === 1 ? 'dia' : 'dias'} de execução`;

/**
 * A estimativa em palavras. É sempre APROXIMADA: depende de números que caem, de contatos manuais, de respostas e de leads
 * que deixam de ser elegíveis. Nunca promete uma data.
 */
export function estimateText(e: CampaignEstimate): string {
  switch (e.status) {
    case 'no_audience':
      return 'Nenhum lead elegível: não há o que estimar.';
    case 'no_capacity':
      return 'Nenhum número conectado com vaga: sem capacidade para estimar.';
    case 'too_long':
      return `Estimativa aproximada: mais de um ano de execução para ${e.eligible} leads.`;
    case 'beyond_end_date':
      return `Estimativa aproximada: até a data final devem ser atendidos ${e.eligible - e.leftover} de ${e.eligible} leads; ${e.leftover} ficariam de fora.`;
    default:
      return `Estimativa aproximada: cerca de ${dias(e.runDays)}, de ${fmtYmd(e.firstDay)} a ${fmtYmd(e.lastDay)}.`;
  }
}
