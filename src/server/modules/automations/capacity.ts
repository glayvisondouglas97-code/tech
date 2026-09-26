/**
 * Capacidade, estimativa e calendário de uma campanha. Funções PURAS: recebem o "agora", a agenda (`window.ts`) e o uso
 * de cada número (a cota unificada, lida de `whatsapp/quota.ts`) e devolvem contas. Nada aqui consulta o banco nem cria
 * regra de cota: quem descobre "quanto cada número ainda pode fazer hoje" é a cota existente.
 *
 * - Capacidade de HOJE: só os números conectados e com vaga, já descontados os contatos manuais e automáticos de hoje; e
 *   só se hoje é um dia da campanha e a janela de hoje ainda não fechou.
 * - Capacidade de um dia FUTURO: números conectados x limite (o dia vazio; não dá para saber quantos contatos manuais
 *   alguém fará no futuro).
 * - Estimativa: consome o público dia a dia. É APROXIMADA: depende de números que caem, de contatos manuais, de respostas
 *   e de leads que deixam de ser elegíveis.
 */
import type { CalendarDay, CampaignEstimate } from '../../../shared/campaign-plan';
import { addDays, dayAllowed, isoWeekday, type Schedule, spDate, spTime } from './window';

export interface CapacityNumber {
  connected: boolean;
  /** Quantos contatos ainda cabem HOJE neste número (limite da campanha menos o que já foi feito). */
  remainingToday: number;
  /** Teto de contatos por dia deste número na campanha (no máximo 20). */
  limit: number;
}

/** Até quantos dias a estimativa procura. Depois disso a resposta é "mais de um ano". */
export const MAX_ESTIMATE_DAYS = 366;

/** Quanto cabe num dia cheio: números conectados x limite. */
export function capacityPerDay(numbers: readonly CapacityNumber[]): number {
  return numbers.filter((n) => n.connected).reduce((sum, n) => sum + n.limit, 0);
}

/** Quanto ainda cabe HOJE. Zero se hoje não é dia da campanha ou se a janela de hoje já fechou. */
export function capacityToday(now: Date, s: Schedule, numbers: readonly CapacityNumber[]): number {
  const t = spTime(now);
  if (!dayAllowed(t.date, s) || t.minutes >= s.endMin) return 0;
  return numbers.filter((n) => n.connected).reduce((sum, n) => sum + n.remainingToday, 0);
}

/** O que acontece num dia (de hoje em diante). */
export function dayInfo(
  now: Date,
  s: Schedule,
  numbers: readonly CapacityNumber[],
  date: string,
): CalendarDay {
  const weekday = isoWeekday(date);
  const base = { date, weekday };
  if (s.startDate && date < s.startDate) return { ...base, state: 'before_start', capacity: 0 };
  if (s.endDate && date > s.endDate) return { ...base, state: 'after_end', capacity: 0 };
  if (!s.days.includes(weekday)) return { ...base, state: 'not_allowed', capacity: 0 };
  if (date === spDate(now)) {
    if (spTime(now).minutes >= s.endMin) return { ...base, state: 'window_closed', capacity: 0 };
    return { ...base, state: 'runs', capacity: capacityToday(now, s, numbers) };
  }
  return { ...base, state: 'runs', capacity: capacityPerDay(numbers) };
}

/** Os próximos `days` dias, a partir de hoje (São Paulo). */
export function buildCalendar(
  now: Date,
  s: Schedule,
  numbers: readonly CapacityNumber[],
  days = 14,
): CalendarDay[] {
  const today = spDate(now);
  return Array.from({ length: days }, (_, i) => dayInfo(now, s, numbers, addDays(today, i)));
}

/** Quanto tempo o público leva para ser atendido, contando a cota de hoje e os dias em que a campanha executa. */
export function estimateDuration(
  now: Date,
  s: Schedule,
  numbers: readonly CapacityNumber[],
  eligible: number,
): CampaignEstimate {
  const perDay = capacityPerDay(numbers);
  const base: CampaignEstimate = {
    status: 'ok',
    eligible,
    connectedNumbers: numbers.filter((n) => n.connected).length,
    capacityToday: capacityToday(now, s, numbers),
    capacityPerDay: perDay,
    runDays: 0,
    firstDay: null,
    lastDay: null,
    leftover: 0,
  };
  if (eligible <= 0) return { ...base, status: 'no_audience' };
  if (perDay <= 0) return { ...base, status: 'no_capacity', leftover: eligible };

  let remaining = eligible;
  const today = spDate(now);
  let runDays = 0;
  let firstDay: string | null = null;
  let lastDay: string | null = null;
  let reachedEnd = false;
  for (let i = 0; i < MAX_ESTIMATE_DAYS && remaining > 0; i++) {
    const date = addDays(today, i);
    if (s.endDate && date > s.endDate) {
      reachedEnd = true;
      break;
    }
    const day = dayInfo(now, s, numbers, date);
    if (day.state !== 'runs' || day.capacity <= 0) continue;
    runDays += 1;
    firstDay ??= date;
    lastDay = date;
    remaining -= day.capacity;
  }
  const leftover = Math.max(0, remaining);
  const status = leftover === 0 ? 'ok' : reachedEnd ? 'beyond_end_date' : 'too_long';
  return { ...base, status, runDays, firstDay, lastDay, leftover };
}
