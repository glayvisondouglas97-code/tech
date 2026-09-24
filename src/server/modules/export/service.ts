import { Readable } from 'node:stream';
import { type Kysely, sql } from 'kysely';
import * as XLSX from 'xlsx';
import type { LeadItem } from '../../../shared/api';
import { resultLabel } from '../../../shared/results';
import type { AuthUser } from '../../auth/sessions';
import type { Database } from '../../db/schema';
import { CSV_BOM, csvLine } from '../../lib/csv';
import { badRequest } from '../../lib/errors';
import { formatDateTimeSP } from '../../lib/time';
import { selectLeads, toLeadItem } from '../leads/dto';
import { applyFilters, type ListFilters } from '../leads/service';

type Db = Kysely<Database>;

const BATCH = 2000;
export const MAX_XLSX_ROWS = 150_000;

function situation(l: LeadItem): string {
  if (l.status === 'bloqueado') return 'Não contatar';
  if (l.calledAt) return 'Chamado';
  return l.assignedTo ? 'Na fila de atendente' : 'Livre';
}

const FIXED = [
  'Empresa',
  'Sócio / proprietário',
  'Telefone',
  'Outros telefones',
  'Tipo',
  'Lista',
  'Situação',
  'Na fila de',
  'Chamado por',
  'Chamado em',
  'Resultado',
  'Observação',
  'Retorno agendado',
  'WhatsApp aberto em',
];

function toRow(l: LeadItem, extraKeys: string[]): (string | number)[] {
  return [
    l.company,
    l.name,
    l.phoneDisplay,
    l.extraPhones.map((p) => p.display).join(' / '),
    l.phoneType === 'movel' ? 'Celular' : l.phoneType === 'fixo' ? 'Fixo' : '',
    l.list.name,
    situation(l),
    l.status === 'pendente' ? (l.assignedTo?.name ?? '') : '',
    l.calledBy?.name ?? '',
    formatDateTimeSP(l.calledAt),
    l.calledAt ? resultLabel(l.result) : '',
    l.note ?? '',
    formatDateTimeSP(l.callbackAt),
    formatDateTimeSP(l.whatsappOpenedAt),
    ...extraKeys.map((k) => l.extra[k] ?? ''),
  ];
}

async function extraKeysFor(db: Db, f: ListFilters): Promise<string[]> {
  let q = db.selectFrom('lists').select(sql<string>`unnest(extra_columns)`.as('k'));
  if (f.list) q = q.where('id', '=', f.list);
  const rows = await q.execute();
  return [...new Set(rows.map((r) => r.k))].slice(0, 60);
}

async function* batches(db: Db, user: AuthUser, f: ListFilters) {
  let lastId = 0;
  for (;;) {
    const rows = await applyFilters(selectLeads(db), user, f)
      .where('l.id', '>', lastId)
      .orderBy('l.id')
      .limit(BATCH)
      .execute();
    if (!rows.length) return;
    lastId = rows[rows.length - 1]?.id ?? lastId;
    yield rows.map(toLeadItem);
    if (rows.length < BATCH) return;
  }
}

export async function countForExport(db: Db, user: AuthUser, f: ListFilters): Promise<number> {
  const r = await applyFilters(selectLeads(db), user, f)
    .clearSelect()
    .select(sql<number>`count(*)`.as('n'))
    .executeTakeFirstOrThrow();
  return r.n;
}

/** CSV com ";" e BOM (abre direto no Excel em português), gerado aos poucos sem carregar tudo na memória. */
export async function csvStream(db: Db, user: AuthUser, f: ListFilters): Promise<Readable> {
  const extraKeys = await extraKeysFor(db, f);
  async function* gen() {
    yield CSV_BOM + csvLine([...FIXED, ...extraKeys]);
    for await (const items of batches(db, user, f)) {
      yield items.map((l) => csvLine(toRow(l, extraKeys))).join('');
    }
  }
  return Readable.from(gen());
}

export async function xlsxBuffer(db: Db, user: AuthUser, f: ListFilters): Promise<Buffer> {
  const total = await countForExport(db, user, f);
  if (total > MAX_XLSX_ROWS) {
    throw badRequest(
      `São ${total.toLocaleString('pt-BR')} linhas: grande demais para Excel. Use o CSV ou filtre mais.`,
    );
  }
  const extraKeys = await extraKeysFor(db, f);
  const aoa: (string | number)[][] = [[...FIXED, ...extraKeys]];
  for await (const items of batches(db, user, f)) for (const l of items) aoa.push(toRow(l, extraKeys));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = aoa[0]?.map((h, i) => ({
    wch: i === 0 ? 28 : i === 10 ? 40 : Math.max(12, String(h).length + 2),
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Leads');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
}
