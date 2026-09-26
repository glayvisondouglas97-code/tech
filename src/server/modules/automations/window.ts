/**
 * Horário de trabalho das campanhas, sempre em São Paulo (`America/Sao_Paulo`): o dia dos limites diários e a
 * janela de envio nunca são decididos em UTC. Funções puras (recebem o "agora"), fáceis de testar.
 */
import { CAMPAIGN_TIMEZONE } from '../../../shared/automations';

const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAMPAIGN_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export interface SpTime {
  /** AAAA-MM-DD em São Paulo. */
  date: string;
  /** Minutos desde a meia-noite de São Paulo (0 a 1439). */
  minutes: number;
  seconds: number;
}

export function spTime(at: Date): SpTime {
  const p: Record<string, string> = {};
  for (const part of parts.formatToParts(at)) if (part.type !== 'literal') p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    seconds: Number(p.second),
  };
}

/** O dia de hoje em São Paulo (AAAA-MM-DD): é o que separa a contagem de um dia da do outro. */
export const spDate = (at: Date): string => spTime(at).date;

/** Soma dias a uma data AAAA-MM-DD. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** O instante (UTC) em que, em São Paulo, é `date` às `minutes` minutos depois da meia-noite. */
export function spInstant(date: string, minutes: number): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wanted = Date.UTC(y, m - 1, d, 0, minutes) / 60_000;
  let guess = Date.UTC(y, m - 1, d, 0, minutes) + 3 * 3_600_000; // São Paulo é UTC-3; abaixo confere de verdade
  for (let i = 0; i < 2; i++) {
    const t = spTime(new Date(guess));
    const [ty, tm, td] = t.date.split('-').map(Number) as [number, number, number];
    guess += (wanted - Date.UTC(ty, tm - 1, td, 0, t.minutes) / 60_000) * 60_000;
  }
  return new Date(guess);
}

/** Está dentro da janela [início, fim)? */
export function insideWindow(at: Date, startMin: number, endMin: number): boolean {
  const { minutes } = spTime(at);
  return minutes >= startMin && minutes < endMin;
}

/** O próprio instante se estiver na janela; senão, quando ela abre (hoje, se ainda não abriu; amanhã, se já fechou). */
export function nextWindowOpening(at: Date, startMin: number, endMin: number): Date {
  const t = spTime(at);
  if (t.minutes >= startMin && t.minutes < endMin) return at;
  if (t.minutes < startMin) return spInstant(t.date, startMin);
  return spInstant(addDays(t.date, 1), startMin);
}

// ---------- agenda da campanha: janela + dias da semana + datas (tudo em São Paulo) ----------

/**
 * Quando uma campanha pode ENVIAR: dentro do horário de trabalho `[startMin, endMin)`, num dia permitido da semana e
 * entre a data inicial e a data final (inclusive). Datas em AAAA-MM-DD de São Paulo; `days` em ISO (1 = segunda ... 7 =
 * domingo). Nada aqui olha o fuso do navegador nem o do servidor.
 */
export interface Schedule {
  startMin: number;
  endMin: number;
  days: readonly number[];
  startDate: string | null;
  endDate: string | null;
}

/** Uma data do banco (`date`, que o driver devolve como Date à meia-noite local) ou texto → AAAA-MM-DD do calendário. */
export function ymd(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** Dia da semana de uma data AAAA-MM-DD: 1 = segunda ... 7 = domingo. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0 = domingo
  return day === 0 ? 7 : day;
}

/** A campanha executa neste dia? (dia da semana permitido e dentro das datas) */
export function dayAllowed(date: string, s: Schedule): boolean {
  if (!s.days.includes(isoWeekday(date))) return false;
  if (s.startDate && date < s.startDate) return false;
  if (s.endDate && date > s.endDate) return false;
  return true;
}

/** Pode enviar agora? Janela E dia permitido E dentro das datas. */
export function insideSchedule(at: Date, s: Schedule): boolean {
  const t = spTime(at);
  return t.minutes >= s.startMin && t.minutes < s.endMin && dayAllowed(t.date, s);
}

/**
 * O próprio instante se já puder enviar; senão, a próxima abertura válida (a janela de hoje, se ainda não abriu; ou a
 * do próximo dia permitido). Devolve null se não houver mais nenhuma (passou da data final).
 */
export function nextScheduleOpening(at: Date, s: Schedule): Date | null {
  const t = spTime(at);
  let date = t.date;
  for (let i = 0; i < 400; i++) {
    if (s.endDate && date > s.endDate) return null;
    if (dayAllowed(date, s)) {
      if (i === 0) {
        if (t.minutes >= s.startMin && t.minutes < s.endMin) return at;
        if (t.minutes < s.startMin) return spInstant(date, s.startMin);
      } else {
        return spInstant(date, s.startMin);
      }
    }
    date = addDays(date, 1);
  }
  return null;
}

/** As etapas seguintes de uma execução que já começou seguem o horário e os dias, mas não as datas. */
export const followUpSchedule = (s: Schedule): Schedule => ({ ...s, startDate: null, endDate: null });

/** A agenda de uma campanha a partir da linha do banco. */
export function scheduleOf(row: {
  window_start_min: number;
  window_end_min: number;
  days_of_week: readonly number[];
  start_date: Date | string;
  end_date: Date | string | null;
}): Schedule {
  return {
    startMin: row.window_start_min,
    endMin: row.window_end_min,
    days: row.days_of_week,
    startDate: ymd(row.start_date),
    endDate: row.end_date ? ymd(row.end_date) : null,
  };
}

/** Variação (em segundos, no máximo) somada ao horário de cada envio, para dois envios não caírem no mesmo segundo. */
export const JITTER_SECONDS = 45;

/**
 * Quando o próximo lead de um número deve ser enviado. As vagas que sobram no dia são espalhadas pelo tempo que
 * resta da janela, em intervalos iguais (20 vagas em 6 horas = um envio a cada ~18 minutos), em vez de
 * despejar tudo no começo. O primeiro do dia sai na abertura da janela. A pequena variação é DETERMINÍSTICA
 * (vem do `seed`, por exemplo o id do lead): só evita horários idênticos, não tenta imitar comportamento humano.
 * Devolve null se a janela de hoje já fechou ou se o número não tem mais vagas hoje.
 */
export function planSlot(
  now: Date,
  o: { startMin: number; endMin: number; limit: number; used: number; seed: number },
): Date | null {
  const t = spTime(now);
  if (t.minutes >= o.endMin) return null;
  const remaining = o.limit - o.used; // vagas que faltam hoje, contando esta
  if (remaining <= 0) return null;
  const open = spInstant(t.date, o.startMin);
  const close = spInstant(t.date, o.endMin);
  const from = now.getTime() > open.getTime() ? now : open;
  const jitter = (Math.abs(o.seed) % JITTER_SECONDS) * 1000;
  // Divide por "vagas + 1": o último envio do dia cai antes do fim da janela, não no último segundo dela.
  const gap = o.used === 0 ? 0 : (close.getTime() - from.getTime()) / (remaining + 1);
  const slot = Math.min(from.getTime() + gap + jitter, close.getTime() - 1000);
  return new Date(Math.max(slot, from.getTime()));
}
