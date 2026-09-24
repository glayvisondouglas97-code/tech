import { extname } from 'node:path';
import * as XLSX from 'xlsx';
import { decodeText, parseCsvText } from './csv-parse';

export const MAX_ROWS = 200_000;
export const MAX_COLUMNS = 60;
const MAX_CELL = 500;

export const TEXT_EXTENSIONS = new Set(['.csv', '.txt', '.tsv']);
export const SHEET_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xls', '.ods']);
export const ACCEPTED_EXTENSIONS = [...SHEET_EXTENSIONS, ...TEXT_EXTENSIONS];

/** Uma linha da planilha. `n` é o número da linha no arquivo (1 = primeira), para o relatório de rejeitados. */
export interface TableRow {
  n: number;
  cells: string[];
}

export interface Table {
  sheets: string[];
  sheet: string | null;
  rows: TableRow[];
  width: number;
}

export class FileReadError extends Error {}

function cleanCell(v: string): string {
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length > MAX_CELL ? s.slice(0, MAX_CELL) : s;
}

function finish(rows: TableRow[], sheets: string[], sheet: string | null): Table {
  const kept: TableRow[] = [];
  for (const r of rows) {
    const cells = r.cells.slice(0, MAX_COLUMNS).map(cleanCell);
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (cells.some((c) => c !== '')) kept.push({ n: r.n, cells });
    if (kept.length > MAX_ROWS) {
      throw new FileReadError(
        `A planilha tem mais de ${MAX_ROWS.toLocaleString('pt-BR')} linhas. Divida em arquivos menores.`,
      );
    }
  }
  const width = Math.max(0, ...kept.slice(0, 1000).map((r) => r.cells.length));
  return { sheets, sheet, rows: kept, width };
}

export function tableFromText(text: string): Table {
  const { rows } = parseCsvText(text);
  return finish(
    rows.map((cells, i) => ({ n: i + 1, cells })),
    [],
    null,
  );
}

function isZip(b: Uint8Array) {
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}
function isOle(b: Uint8Array) {
  return b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
}

function cellText(c: XLSX.CellObject | undefined): string {
  if (!c || c.v == null) return '';
  switch (c.t) {
    case 's':
      return String(c.v);
    case 'b':
      return c.v ? 'Sim' : 'Não';
    case 'e':
    case 'z':
      return '';
    case 'd':
      return (c.v as Date).toISOString().slice(0, 10).split('-').reverse().join('/');
    case 'n': {
      const v = c.v as number;
      if (c.z && XLSX.SSF.is_date(c.z)) return XLSX.SSF.format(v % 1 ? 'dd/mm/yyyy hh:mm' : 'dd/mm/yyyy', v);
      // Inteiros sem notação científica (telefones salvos como número no Excel).
      if (Number.isInteger(v)) return Math.abs(v) < 1e21 ? v.toFixed(0) : String(v);
      return v.toLocaleString('pt-BR', { useGrouping: false, maximumFractionDigits: 10 });
    }
    default:
      return String(c.w ?? c.v);
  }
}

export function tableFromWorkbook(data: Uint8Array, sheetName?: string | null): Table {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(data, {
      type: 'buffer',
      dense: true,
      cellNF: true,
      cellDates: false,
      sheetRows: MAX_ROWS + 2,
    });
  } catch {
    throw new FileReadError(
      'Não consegui ler essa planilha. Confira se o arquivo é Excel (.xlsx/.xls) ou CSV.',
    );
  }
  const sheets = wb.SheetNames;
  if (!sheets.length) throw new FileReadError('A planilha não tem nenhuma aba.');
  const chosen = sheetName && sheets.includes(sheetName) ? sheetName : (sheets[0] as string);
  const ws = wb.Sheets[chosen];
  if (!ws?.['!ref']) return { sheets, sheet: chosen, rows: [], width: 0 };
  const range = XLSX.utils.decode_range(ws['!ref']);
  const dense = (ws as unknown as { '!data'?: (XLSX.CellObject | undefined)[][] })['!data'] ?? [];
  const lastCol = Math.min(range.e.c, range.s.c + MAX_COLUMNS - 1);
  const rows: TableRow[] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const line = dense[r];
    if (!line) continue;
    const cells: string[] = [];
    for (let c = range.s.c; c <= lastCol; c++) cells.push(cellText(line[c]));
    rows.push({ n: r + 1, cells });
  }
  return finish(rows, sheets, chosen);
}

/** Lê um arquivo enviado (ou texto colado) e devolve a tabela da aba escolhida. */
export function readTable(data: Uint8Array, fileName: string, sheet?: string | null): Table {
  const ext = extname(fileName).toLowerCase();
  if (isZip(data) || isOle(data) || SHEET_EXTENSIONS.has(ext)) return tableFromWorkbook(data, sheet);
  if (TEXT_EXTENSIONS.has(ext) || !ext) return tableFromText(decodeText(data));
  throw new FileReadError('Formato não aceito. Envie uma planilha .xlsx, .xls, .ods ou .csv.');
}
