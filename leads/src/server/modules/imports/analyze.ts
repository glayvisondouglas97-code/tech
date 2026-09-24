import { normalizeText } from '../../../shared/text';
import { describeColumns } from './detect';
import { normalizePhones, PHONE_ERROR_LABEL, type Phone, type PhoneError } from './phone';
import type { Table } from './read-file';

export interface Mapping {
  hasHeader: boolean;
  /** -1 = sem coluna de empresa. */
  companyColumn: number;
  /** -1 = sem coluna de nome (sócio / proprietário). */
  nameColumn: number;
  phoneColumn: number;
  defaultDdd: string | null;
}

export type DedupeBase = 'todos' | 'pendentes' | 'nenhum';

export interface DedupeOptions {
  /** Pular telefones repetidos dentro do próprio arquivo. */
  inFile: boolean;
  /** todos = pula se o telefone já existe em qualquer lista, inclusive já chamados;
   *  pendentes = pula só se ainda está esperando contato; nenhum = não compara com a base. */
  base: DedupeBase;
}

export interface PreparedRow {
  rowNumber: number;
  company: string;
  name: string;
  phone: Phone | null;
  otherPhones: Phone[];
  extra: Record<string, string>;
  error: PhoneError | null;
  values: string[];
}

export interface ExtraColumn {
  index: number;
  key: string;
}

const MAX_EXTRA_COLUMNS = 30;
const MAX_EXTRA_VALUE = 300;
const MAX_NAME = 120;
const MAX_COMPANY = 160;

const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * Aplica o mapeamento de colunas e normaliza os telefones de cada linha.
 * Cede a vez ao Node a cada 1.000 linhas para não travar o servidor em arquivos grandes.
 */
export async function prepareRows(
  table: Table,
  mapping: Mapping,
  onProgress?: (done: number, total: number) => void,
): Promise<{ extraColumns: ExtraColumn[]; rows: PreparedRow[]; headerLabels: string[] }> {
  const raw = table.rows.map((r) => r.cells);
  const columns = describeColumns(raw, mapping.hasHeader, table.width);
  const data = mapping.hasHeader ? table.rows.slice(1) : table.rows;

  const used = new Set<number>();
  for (const r of data) {
    r.cells.forEach((v, i) => {
      if (v) used.add(i);
    });
    if (used.size >= table.width) break;
  }
  const extraColumns: ExtraColumn[] = columns
    .filter(
      (c) =>
        c.index !== mapping.nameColumn &&
        c.index !== mapping.phoneColumn &&
        c.index !== mapping.companyColumn &&
        used.has(c.index),
    )
    .slice(0, MAX_EXTRA_COLUMNS)
    .map((c) => ({ index: c.index, key: c.label }));

  const rows: PreparedRow[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i % 1000 === 999) {
      onProgress?.(i, data.length);
      await tick();
    }
    const row = data[i] as Table['rows'][number];
    const cells = row.cells;
    const parsed = normalizePhones(cells[mapping.phoneColumn] ?? '', mapping.defaultDdd);
    const text = (col: number, max: number) =>
      col >= 0
        ? String(cells[col] ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, max)
        : '';
    const name = text(mapping.nameColumn, MAX_NAME);
    const company = text(mapping.companyColumn, MAX_COMPANY);
    const extra: Record<string, string> = {};
    for (const c of extraColumns) {
      const v = cells[c.index];
      if (v) extra[c.key] = v.slice(0, MAX_EXTRA_VALUE);
    }
    rows.push({
      rowNumber: row.n,
      company,
      name,
      phone: parsed.phones[0] ?? null,
      otherPhones: parsed.phones.slice(1, 4),
      extra,
      error: parsed.error,
      values: cells,
    });
  }
  onProgress?.(data.length, data.length);
  return { extraColumns, rows, headerLabels: columns.map((c) => c.label) };
}

export interface ExistingInfo {
  listName: string;
  called: boolean;
}

export interface Lookup {
  blocked: Set<string>;
  existing: Map<string, ExistingInfo>;
}

export interface Rejected {
  rowNumber: number;
  reason: string;
  values: string[];
}

export interface Counts {
  /** Linhas com algum dado (sem contar o cabeçalho). */
  total: number;
  valid: number;
  invalid: number;
  duplicatesInFile: number;
  duplicatesInBase: number;
  blocked: number;
  /** Entre os válidos: empresas diferentes e telefones (principal + extras). */
  companies: number;
  phones: number;
}

export interface Finalized {
  valid: (PreparedRow & { phone: Phone })[];
  rejected: Rejected[];
  counts: Counts;
}

/** Decide quais linhas entram: tira inválidos, bloqueados (não contatar) e repetidos. */
export function finalizeRows(rows: PreparedRow[], lookup: Lookup, dedupe: DedupeOptions): Finalized {
  const valid: Finalized['valid'] = [];
  const rejected: Rejected[] = [];
  const counts: Counts = {
    total: rows.length,
    valid: 0,
    invalid: 0,
    duplicatesInFile: 0,
    duplicatesInBase: 0,
    blocked: 0,
    companies: 0,
    phones: 0,
  };
  const firstSeen = new Map<string, number>();
  for (const r of rows) {
    if (!r.phone) {
      counts.invalid++;
      rejected.push({
        rowNumber: r.rowNumber,
        reason: PHONE_ERROR_LABEL[r.error ?? 'invalido'],
        values: r.values,
      });
      continue;
    }
    const p = r.phone.e164;
    if (lookup.blocked.has(p)) {
      counts.blocked++;
      rejected.push({ rowNumber: r.rowNumber, reason: 'Número na lista de não contatar', values: r.values });
      continue;
    }
    const first = firstSeen.get(p);
    if (dedupe.inFile && first !== undefined) {
      counts.duplicatesInFile++;
      rejected.push({
        rowNumber: r.rowNumber,
        reason: `Repetido no arquivo (mesmo telefone da linha ${first})`,
        values: r.values,
      });
      continue;
    }
    if (first === undefined) firstSeen.set(p, r.rowNumber);
    const ex = dedupe.base === 'nenhum' ? undefined : lookup.existing.get(p);
    if (ex) {
      counts.duplicatesInBase++;
      rejected.push({
        rowNumber: r.rowNumber,
        reason: ex.called
          ? `Já foi chamado (lista "${ex.listName}")`
          : `Já está na base (lista "${ex.listName}")`,
        values: r.values,
      });
      continue;
    }
    valid.push(r as PreparedRow & { phone: Phone });
  }
  counts.valid = valid.length;
  // Sem coluna de empresa, cada linha conta como uma empresa.
  counts.companies = new Set(valid.map((r) => normalizeText(r.company) || `#${r.rowNumber}`)).size;
  counts.phones = valid.reduce((n, r) => n + 1 + r.otherPhones.length, 0);
  return { valid, rejected, counts };
}

/** Texto usado na busca por nome (sem acentos, minúsculo). */
export function searchableName(name: string): string {
  return normalizeText(name);
}
