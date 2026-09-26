/** Datas sempre no horário de São Paulo, independente do relógio do aparelho. */
export const TZ = 'America/Sao_Paulo';

const nf = new Intl.NumberFormat('pt-BR');
export const fmtN = (n: number | null | undefined) => nf.format(n ?? 0);
export const fmtPct = (n: number | null | undefined) =>
  n == null ? '—' : `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

const ymdFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const hmFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dmFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' });
const dmyFmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const weekdayFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'short' });

/** AAAA-MM-DD em São Paulo. */
export function ymdSP(d: Date | string = new Date()): string {
  return ymdFmt.format(new Date(d));
}

function dayDiff(iso: string): number {
  const a = Date.parse(`${ymdSP(iso)}T00:00:00Z`);
  const b = Date.parse(`${ymdSP()}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

/** "hoje, 14:32", "ontem, 09:10", "amanhã, 10:00", "12/09, 14:32". */
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = dayDiff(iso);
  const hm = hmFmt.format(new Date(iso));
  if (diff === 0) return `hoje, ${hm}`;
  if (diff === -1) return `ontem, ${hm}`;
  if (diff === 1) return `amanhã, ${hm}`;
  const sameYear = ymdSP(iso).slice(0, 4) === ymdSP().slice(0, 4);
  return `${sameYear ? dmFmt.format(new Date(iso)) : dmyFmt.format(new Date(iso))}, ${hm}`;
}

export function fmtDate(iso: string | null | undefined): string {
  return iso ? dmyFmt.format(new Date(iso)) : '';
}

/** "2026-10-01" (data do calendário, sem hora) → "01/10/2026". Não passa por `Date`: nunca escorrega de dia. */
export function fmtYmd(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

export function fmtDayShort(ymd: string): { label: string; weekday: string } {
  const d = new Date(`${ymd}T12:00:00-03:00`);
  return { label: dmFmt.format(d), weekday: weekdayFmt.format(d).replace('.', '') };
}

/** Converte "AAAA-MM-DDTHH:mm" (campo datetime-local, horário de SP) para ISO. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  // Brasil sem horário de verão desde 2019: São Paulo é UTC−3.
  const d = new Date(`${value}:00-03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO → "AAAA-MM-DDTHH:mm" no horário de SP (para preencher o datetime-local). */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() - 3 * 3_600_000);
  return d.toISOString().slice(0, 16);
}

export function plural(n: number, one: string, many: string): string {
  return `${fmtN(n)} ${n === 1 ? one : many}`;
}
