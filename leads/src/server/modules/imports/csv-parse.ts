/**
 * Leitura de CSV/TXT exportado de planilhas brasileiras.
 * - Codificação: UTF-8 (com ou sem BOM), UTF-16 (Excel "Texto Unicode") ou Windows-1252 (Excel antigo).
 * - Separador detectado sozinho entre ; , tab e |, ou indicado pela linha "sep=;" do Excel.
 * - Aspas no padrão RFC 4180: "texto com ; dentro", "aspas ""duplas""" e quebras de linha dentro de aspas.
 */

export const DELIMITERS = [';', ',', '\t', '|'] as const;

export function decodeText(buf: Uint8Array): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1252').decode(buf);
  }
  return text.replace(/^﻿/, '');
}

/** Divide o texto em registros sem quebrar campos entre aspas (só para amostragem). */
function sampleRecords(text: string, max: number): string[] {
  const out: string[] = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < text.length && out.length < max; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) {
      const line = text.slice(start, i);
      if (line.trim()) out.push(line);
      if (ch === '\r' && text[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  if (out.length < max) {
    const last = text.slice(start);
    if (last.trim()) out.push(last);
  }
  return out;
}

function countOutsideQuotes(line: string, delim: string): number {
  let n = 0;
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === delim) n++;
  }
  return n;
}

/**
 * Escolhe o separador que aparece o mesmo número de vezes no maior número de linhas.
 * Empate: o que gera mais colunas; depois a ordem ; , tab | (o ";" é o padrão do Excel em português).
 */
export function detectDelimiter(text: string): string {
  const lines = sampleRecords(text, 30);
  let best: string = DELIMITERS[0];
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d)).filter((n) => n > 0);
    if (!counts.length) continue;
    const freq = new Map<number, number>();
    for (const n of counts) freq.set(n, (freq.get(n) ?? 0) + 1);
    let mode = 0;
    let modeFreq = 0;
    for (const [n, f] of freq) {
      if (f > modeFreq || (f === modeFreq && n > mode)) {
        mode = n;
        modeFreq = f;
      }
    }
    const score = (modeFreq / lines.length) * 1000 + Math.min(mode, 100);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      inQuotes = true;
      field = '';
    } else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Texto completo (arquivo ou colado) → linhas e colunas. */
export function parseCsvText(input: string): { delimiter: string; rows: string[][] } {
  let text = input.replace(/^﻿/, '');
  let delimiter: string | null = null;
  const sep = /^sep=(.)\r?\n/i.exec(text);
  if (sep) {
    delimiter = sep[1] as string;
    text = text.slice(sep[0].length);
  }
  delimiter ??= detectDelimiter(text);
  return { delimiter, rows: parseDelimited(text, delimiter) };
}
