/** BOM do UTF-8: faz o Excel em português abrir acentos corretamente. */
export const CSV_BOM = '﻿';

const NEEDS_QUOTES = /[;"\n\r]/;
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?[\d\s().,-]+$/;

/**
 * Uma célula de CSV com ";" como separador.
 * Textos que começam com =, +, -, @ ganham um apóstrofo na frente para o Excel
 * não executar como fórmula (injeção de CSV). Números e telefones ficam intactos.
 */
export function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values: unknown[]): string {
  return `${values.map(csvCell).join(';')}\r\n`;
}
