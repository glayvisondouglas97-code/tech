import { sql } from 'kysely';

/** Fuso fixo da operação. "Hoje" é sempre o dia de São Paulo, não o do servidor nem o do navegador. */
export const TZ = 'America/Sao_Paulo';

/** Início do dia em São Paulo, `daysAgo` dias atrás (0 = hoje), como timestamptz. */
export function spDayStart(daysAgo = 0) {
  return sql<Date>`((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') - make_interval(days => ${daysAgo}::int)) AT TIME ZONE 'America/Sao_Paulo')`;
}

/** Meia-noite de uma data AAAA-MM-DD em São Paulo, como timestamptz. */
export function spDateStart(ymd: string) {
  return sql<Date>`((${ymd}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
}

/** Fim do dia (meia-noite do dia seguinte) de uma data AAAA-MM-DD em São Paulo. */
export function spDateEnd(ymd: string) {
  return sql<Date>`(((${ymd}::date) + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
}

const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const dateFmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export function formatDateTimeSP(d: Date | string | null | undefined): string {
  if (!d) return '';
  return dateTimeFmt.format(new Date(d)).replace(',', '');
}

export function formatDateSP(d: Date | string | null | undefined): string {
  if (!d) return '';
  return dateFmt.format(new Date(d));
}

/** AAAA-MM-DD de hoje em São Paulo (para nomes de arquivo). */
export function todayStampSP(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return parts.format(new Date());
}
