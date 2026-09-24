import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import type {
  ImportCounts,
  ImportDraft,
  ImportOptions,
  ImportPreview,
  ImportState,
  UserRef,
} from '../../../shared/api';
import { normalizeText } from '../../../shared/text';
import type { AuthUser } from '../../auth/sessions';
import type { Database } from '../../db/schema';
import { audit } from '../../lib/audit';
import { CSV_BOM, csvLine } from '../../lib/csv';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { formatDateSP } from '../../lib/time';
import { getSettings } from '../settings/service';
import { type DedupeBase, type Finalized, finalizeRows, type Lookup, prepareRows } from './analyze';
import { describeColumns, detectColumns, detectHeader } from './detect';
import { displayPhone } from './phone';
import { ACCEPTED_EXTENSIONS, MAX_COLUMNS, type Table } from './read-file';
import { cachedTable, cacheTable, forgetTables, readTableAsync } from './table-reader';

/** Chave do lock que deixa uma importação por vez gravar (a checagem de duplicados fica consistente). */
const IMPORT_LOCK = 720_001;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Ganchos só para testes (simular falha no meio da gravação). */
export const importTestHooks: { afterLeadsInserted?: () => Promise<void> | void } = {};

const progress = new Map<string, { phase: string; done: number; total: number }>();

export const importOptionsSchema = z.object({
  sheet: z.string().max(200).nullable().default(null),
  hasHeader: z.boolean(),
  companyColumn: z.number().int().min(-1).max(MAX_COLUMNS).default(-1),
  nameColumn: z.number().int().min(-1).max(MAX_COLUMNS),
  phoneColumn: z.number().int().min(0).max(MAX_COLUMNS),
  defaultDdd: z
    .string()
    .nullable()
    .default(null)
    .transform((v) => (v ? v.replace(/\D/g, '') : null))
    .refine(
      (v) => v === null || v === '' || /^[1-9][0-9]$/.test(v),
      'o DDD precisa ter 2 dígitos, como 11 ou 41',
    )
    .transform((v) => (v ? v : null)),
  listName: z.string().trim().max(80).default(''),
  dedupeInFile: z.boolean().default(true),
  dedupeBase: z.enum(['todos', 'pendentes', 'nenhum']).default('todos'),
  distribution: z
    .discriminatedUnion('mode', [
      z.object({ mode: z.literal('fila') }),
      z.object({ mode: z.literal('dividir'), userIds: z.array(z.string().uuid()).max(200) }),
      z.object({ mode: z.literal('pessoa'), userId: z.string().uuid() }),
    ])
    .default({ mode: 'fila' }),
});

type Db = Kysely<Database>;

function defaultListName(fileName: string, source: 'arquivo' | 'colado'): string {
  if (source === 'colado') return `Lista colada em ${formatDateSP(new Date()).slice(0, 5)}`;
  return fileName.replace(/\.[^.]+$/, '').slice(0, 80) || 'Lista sem nome';
}

function tableKey(id: string, sheet: string | null) {
  return `${id}:${sheet ?? ''}`;
}

async function loadImport(db: Db, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound('Importação não encontrada.');
  const imp = await db.selectFrom('imports').selectAll().where('id', '=', id).executeTakeFirst();
  if (!imp) throw notFound('Importação não encontrada.');
  return imp;
}

async function tableFor(
  db: Db,
  imp: { id: string; file_name: string; file_data: Buffer | null },
  sheet: string | null,
) {
  const hit = cachedTable(tableKey(imp.id, sheet));
  if (hit) return hit;
  let data = imp.file_data;
  if (!data) {
    const row = await db
      .selectFrom('imports')
      .select('file_data')
      .where('id', '=', imp.id)
      .executeTakeFirst();
    data = row?.file_data ?? null;
  }
  if (!data) throw conflict('O arquivo desta importação não está mais disponível. Envie de novo.');
  const table = await readTableAsync(data, imp.file_name, sheet);
  cacheTable(tableKey(imp.id, table.sheet), table);
  return table;
}

function suggestion(table: Table, base: Partial<ImportOptions>, defaultDdd: string | null): ImportOptions {
  const raw = table.rows.map((r) => r.cells);
  const hasHeader = base.hasHeader ?? detectHeader(raw);
  const cols = detectColumns(raw, hasHeader);
  return {
    sheet: table.sheet,
    hasHeader,
    companyColumn: cols.company,
    nameColumn: cols.name,
    phoneColumn: Math.max(0, cols.phone),
    defaultDdd,
    listName: base.listName ?? '',
    dedupeInFile: true,
    dedupeBase: 'todos',
    distribution: { mode: 'fila' },
  };
}

function draftView(
  imp: { id: string; file_name: string },
  table: Table,
  sugg: ImportOptions,
  previous: ImportDraft['previous'],
): ImportDraft {
  const raw = table.rows.map((r) => r.cells);
  return {
    id: imp.id,
    fileName: imp.file_name,
    sheets: table.sheets,
    sheet: table.sheet,
    rowCount: table.rows.length,
    columns: describeColumns(raw, sugg.hasHeader, table.width).map(({ index, letter, label }) => ({
      index,
      letter,
      label,
    })),
    sample: raw.slice(0, 8),
    suggestion: sugg,
    previous,
  };
}

/** Passo 1: recebe o arquivo (ou o texto colado), lê e sugere o mapeamento. Nada entra na base ainda. */
export async function createDraft(
  db: Db,
  user: AuthUser,
  input: { fileName: string; data: Buffer; source: 'arquivo' | 'colado' },
): Promise<ImportDraft> {
  if (!input.data.length) throw badRequest('O arquivo está vazio.');
  if (input.data.length > MAX_FILE_BYTES) throw badRequest('Arquivo grande demais (máximo 25 MB).');
  const ext = extname(input.fileName).toLowerCase();
  if (input.source === 'arquivo' && !ACCEPTED_EXTENSIONS.includes(ext)) {
    throw badRequest('Formato não aceito. Envie uma planilha .xlsx, .xls, .ods ou .csv.');
  }
  const table = await readTableAsync(input.data, input.fileName, null);
  if (!table.rows.length) throw badRequest('Não encontrei linhas com dados nesse arquivo.');

  const sha = createHash('sha256').update(input.data).digest('hex');
  const imp = await db
    .insertInto('imports')
    .values({
      created_by: user.id,
      source: input.source,
      file_name: input.fileName.slice(0, 200),
      file_sha256: sha,
      file_size: input.data.length,
      file_data: input.data,
    })
    .returning(['id', 'file_name'])
    .executeTakeFirstOrThrow();
  cacheTable(tableKey(imp.id, table.sheet), table);

  const prev = await db
    .selectFrom('imports as i')
    .leftJoin('lists as li', 'li.id', 'i.list_id')
    .select(['i.finished_at', 'li.name'])
    .where('i.file_sha256', '=', sha)
    .where('i.status', '=', 'concluida')
    .orderBy('i.finished_at', 'desc')
    .executeTakeFirst();

  const settings = await getSettings(db);
  const sugg = suggestion(
    table,
    { listName: defaultListName(input.fileName, input.source) },
    settings.default_ddd,
  );
  return draftView(
    imp,
    table,
    sugg,
    prev ? { date: prev.finished_at?.toISOString() ?? '', listName: prev.name ?? null } : null,
  );
}

/** Trocar a aba ou o "tem cabeçalho" refaz a detecção das colunas. */
export async function redetect(
  db: Db,
  id: string,
  input: { sheet: string | null; hasHeader?: boolean; listName?: string },
): Promise<ImportDraft> {
  const imp = await loadImport(db, id);
  if (imp.status !== 'rascunho' && imp.status !== 'falhou')
    throw conflict('Esta importação já foi processada.');
  const table = await tableFor(db, imp, input.sheet);
  const settings = await getSettings(db);
  const sugg = suggestion(
    table,
    { hasHeader: input.hasHeader, listName: input.listName },
    settings.default_ddd,
  );
  return draftView(imp, table, sugg, null);
}

export async function lookupPhones(db: Db, phones: string[], base: DedupeBase): Promise<Lookup> {
  const unique = [...new Set(phones)];
  const lookup: Lookup = { blocked: new Set(), existing: new Map() };
  for (let i = 0; i < unique.length; i += 10_000) {
    const chunk = unique.slice(i, i + 10_000);
    const blocked = await sql<{ phone: string }>`
      SELECT b.phone FROM blocked_phones b
      JOIN unnest(${chunk}::text[]) AS u(phone) ON u.phone = b.phone`.execute(db);
    for (const r of blocked.rows) lookup.blocked.add(r.phone);
    if (base === 'nenhum') continue;
    const existing = await sql<{ phone: string; list_name: string; called: boolean }>`
      SELECT DISTINCT ON (l.phone) l.phone, li.name AS list_name, (l.called_at IS NOT NULL) AS called
      FROM leads l
      JOIN lists li ON li.id = l.list_id
      JOIN unnest(${chunk}::text[]) AS u(phone) ON u.phone = l.phone
      WHERE l.anonymized_at IS NULL ${base === 'pendentes' ? sql`AND l.status = 'pendente'` : sql``}
      ORDER BY l.phone, l.id DESC`.execute(db);
    for (const r of existing.rows) lookup.existing.set(r.phone, { listName: r.list_name, called: r.called });
  }
  return lookup;
}

async function resolveTargets(db: Db, opts: ImportOptions): Promise<UserRef[]> {
  const d = opts.distribution;
  if (d.mode === 'fila') return [];
  const ids = d.mode === 'dividir' ? [...new Set(d.userIds)] : [d.userId];
  if (!ids.length) throw badRequest('Escolha pelo menos um atendente para dividir os leads.');
  const users = await db
    .selectFrom('users')
    .select(['id', 'name'])
    .where('id', 'in', ids)
    .where('active', '=', true)
    .execute();
  if (users.length !== ids.length)
    throw badRequest('Algum atendente escolhido está desativado. Atualize a página.');
  return ids.map((id) => users.find((u) => u.id === id) as UserRef);
}

function perAttendant(valid: number, targets: UserRef[]) {
  return targets.map((user, i) => ({
    user,
    count: Math.floor(valid / targets.length) + (i < valid % targets.length ? 1 : 0),
  }));
}

function checkMapping(table: Table, opts: ImportOptions) {
  if (opts.phoneColumn >= Math.max(1, table.width)) throw badRequest('Escolha a coluna do telefone.');
  if (opts.nameColumn >= table.width) throw badRequest('Escolha a coluna do nome.');
  if (opts.companyColumn >= table.width) throw badRequest('Escolha a coluna da empresa.');
  if (opts.nameColumn === opts.phoneColumn)
    throw badRequest('As colunas de nome e telefone precisam ser diferentes.');
  if (opts.companyColumn >= 0 && opts.companyColumn === opts.phoneColumn)
    throw badRequest('As colunas de empresa e telefone precisam ser diferentes.');
}

/** Passo 2: prévia com os números exatos que vão entrar, repetidos e rejeitados (com motivo). */
export async function previewImport(db: Db, id: string, opts: ImportOptions): Promise<ImportPreview> {
  const imp = await loadImport(db, id);
  if (imp.status !== 'rascunho' && imp.status !== 'falhou')
    throw conflict('Esta importação já foi processada.');
  const table = await tableFor(db, imp, opts.sheet);
  checkMapping(table, opts);
  const prepared = await prepareRows(table, opts);
  const lookup = await lookupPhones(
    db,
    prepared.rows.flatMap((r) => (r.phone ? [r.phone.e164] : [])),
    opts.dedupeBase,
  );
  const fin = finalizeRows(prepared.rows, lookup, { inFile: opts.dedupeInFile, base: opts.dedupeBase });
  const targets = await resolveTargets(db, opts).catch(() => []);
  await db
    .updateTable('imports')
    .set({ options: JSON.stringify(opts) })
    .where('id', '=', id)
    .execute();
  return {
    columns: describeColumns(
      table.rows.map((r) => r.cells),
      opts.hasHeader,
      table.width,
    ).map(({ index, letter, label }) => ({ index, letter, label })),
    counts: fin.counts,
    extraColumns: prepared.extraColumns.map((c) => c.key),
    validSample: fin.valid.slice(0, 10).map((r) => ({
      rowNumber: r.rowNumber,
      company: r.company,
      name: r.name,
      phoneDisplay: displayPhone(r.phone.e164),
      phoneType: r.phone.kind,
      extra: r.extra,
    })),
    rejectedSample: fin.rejected.slice(0, 10),
    perAttendant: perAttendant(fin.counts.valid, targets),
  };
}

/** Passo 3: confirma. Roda em segundo plano, numa transação só: ou entra tudo, ou nada. */
export async function commitImport(
  db: Db,
  user: AuthUser,
  id: string,
  opts: ImportOptions,
  log: FastifyBaseLogger,
): Promise<ImportState> {
  const imp = await loadImport(db, id);
  if (imp.status === 'concluida' || imp.status === 'processando') return getImportState(db, id);
  if (imp.status === 'descartada') throw conflict('Esta importação foi descartada. Envie o arquivo de novo.');
  if (!opts.listName.trim()) throw badRequest('Dê um nome para a lista.');
  await resolveTargets(db, opts);

  // Só uma requisição consegue passar de rascunho/falhou para processando (clique duplo não duplica a lista).
  const claimed = await db
    .updateTable('imports')
    .set({ status: 'processando', started_at: sql`now()`, error: null, options: JSON.stringify(opts) })
    .where('id', '=', id)
    .where('status', 'in', ['rascunho', 'falhou'])
    .returning('id')
    .executeTakeFirst();
  if (!claimed) return getImportState(db, id);

  progress.set(id, { phase: 'Lendo o arquivo', done: 0, total: 0 });
  setImmediate(() => {
    runCommit(db, user, id, opts)
      .catch(async (err) => {
        const userMsg =
          err instanceof AppError ? err.message : 'Erro inesperado ao gravar a lista. Nada foi importado.';
        if (!(err instanceof AppError)) log.error({ err, importId: id }, 'falha na importação');
        await db
          .updateTable('imports')
          .set({ status: 'falhou', error: userMsg, finished_at: sql`now()` })
          .where('id', '=', id)
          .where('status', '=', 'processando')
          .execute()
          .catch((e) => log.error({ err: e }, 'não consegui marcar a importação como falha'));
      })
      .finally(() => progress.delete(id));
  });
  return getImportState(db, id);
}

async function runCommit(db: Db, user: AuthUser, id: string, opts: ImportOptions): Promise<void> {
  const imp = await loadImport(db, id);
  const table = await tableFor(db, imp, opts.sheet);
  checkMapping(table, opts);
  const prepared = await prepareRows(table, opts, (done, total) =>
    progress.set(id, { phase: 'Conferindo os telefones', done, total }),
  );

  await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${IMPORT_LOCK})`.execute(trx);
    const current = await trx
      .selectFrom('imports')
      .select('status')
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (current.status !== 'processando') throw conflict('A importação mudou de estado. Atualize a página.');

    const lookup = await lookupPhones(
      trx,
      prepared.rows.flatMap((r) => (r.phone ? [r.phone.e164] : [])),
      opts.dedupeBase,
    );
    const fin: Finalized = finalizeRows(prepared.rows, lookup, {
      inFile: opts.dedupeInFile,
      base: opts.dedupeBase,
    });
    if (!fin.valid.length)
      throw badRequest('Nenhuma linha válida para importar. Confira a coluna do telefone.');
    const targets = await resolveTargets(trx, opts);

    const list = await trx
      .insertInto('lists')
      .values({
        name: opts.listName.trim().slice(0, 80),
        created_by: user.id,
        extra_columns: prepared.extraColumns.map((c) => c.key),
        total: fin.valid.length,
        distribution: opts.distribution.mode,
        source_file: imp.source === 'arquivo' ? imp.file_name : null,
        import_id: id,
      })
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow();

    const now = new Date();
    const total = fin.valid.length;
    for (let i = 0; i < total; i += 1000) {
      progress.set(id, { phase: 'Gravando os leads', done: i, total });
      const batch = fin.valid.slice(i, i + 1000).map((r, j) => {
        const target = targets.length ? targets[(i + j) % targets.length] : null;
        return {
          list_id: list.id,
          row_number: r.rowNumber,
          name: r.name,
          name_search: normalizeText(r.name),
          company: r.company,
          company_search: normalizeText(r.company),
          phone: r.phone.e164,
          phone_type: r.phone.kind,
          extra_phones: r.otherPhones.map((p) => p.e164),
          extra: JSON.stringify(r.extra),
          assigned_to: target?.id ?? null,
          assigned_at: target ? now : null,
          assigned_via: target ? ('importacao' as const) : null,
        };
      });
      await trx.insertInto('leads').values(batch).execute();
    }
    await importTestHooks.afterLeadsInserted?.();

    progress.set(id, { phase: 'Finalizando', done: total, total });
    await sql`
      INSERT INTO lead_events (lead_id, user_id, type, data)
      SELECT l.id, ${user.id}::uuid, 'importado',
             jsonb_build_object('lista', ${list.name}::text, 'para', l.assigned_to, 'para_nome', u.name)
      FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
      WHERE l.list_id = ${list.id}::uuid`.execute(trx);

    for (let i = 0; i < fin.rejected.length; i += 1000) {
      await trx
        .insertInto('import_rejections')
        .values(
          fin.rejected.slice(i, i + 1000).map((r) => ({
            import_id: id,
            row_number: r.rowNumber,
            reason: r.reason,
            values: r.values,
          })),
        )
        .execute();
    }

    const summary = {
      counts: fin.counts,
      extraColumns: prepared.extraColumns.map((c) => c.key),
      headerLabels: prepared.headerLabels,
      perAttendant: perAttendant(fin.counts.valid, targets),
    };
    await trx
      .updateTable('imports')
      .set({
        status: 'concluida',
        summary: JSON.stringify(summary),
        list_id: list.id,
        finished_at: sql`now()`,
        file_data: null,
      })
      .where('id', '=', id)
      .execute();
    await audit(trx, {
      userId: user.id,
      action: 'importou_lista',
      entity: 'lista',
      entityId: list.id,
      details: {
        lista: list.name,
        leads: fin.counts.valid,
        rejeitadas: fin.rejected.length,
        distribuicao: opts.distribution.mode,
      },
    });
  });
  forgetTables(id);
}

export async function getImportState(db: Db, id: string): Promise<ImportState> {
  const r = await db
    .selectFrom('imports as i')
    .leftJoin('users as u', 'u.id', 'i.created_by')
    .leftJoin('lists as li', 'li.id', 'i.list_id')
    .select([
      'i.id',
      'i.status',
      'i.file_name',
      'i.created_at',
      'i.finished_at',
      'i.error',
      'i.summary',
      'i.created_by',
      'u.name as user_name',
      'li.id as list_id',
      'li.name as list_name',
    ])
    .where('i.id', '=', id)
    .executeTakeFirst();
  if (!r) throw notFound('Importação não encontrada.');
  return toState(r);
}

function toState(r: {
  id: string;
  status: ImportState['status'];
  file_name: string;
  created_at: Date;
  finished_at: Date | null;
  error: string | null;
  summary: unknown;
  created_by: string | null;
  user_name: string | null;
  list_id: string | null;
  list_name: string | null;
}): ImportState {
  const summary = (r.summary ?? null) as { counts?: ImportCounts } | null;
  const counts = summary?.counts ?? null;
  return {
    id: r.id,
    status: r.status,
    fileName: r.file_name,
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by ? { id: r.created_by, name: r.user_name ?? 'Usuário removido' } : null,
    finishedAt: r.finished_at?.toISOString() ?? null,
    error: r.error,
    counts,
    list: r.list_id ? { id: r.list_id, name: r.list_name ?? '' } : null,
    rejectedCount: counts ? counts.total - counts.valid : 0,
    progress: r.status === 'processando' ? (progress.get(r.id) ?? null) : null,
  };
}

export async function listImports(db: Db): Promise<ImportState[]> {
  const rows = await db
    .selectFrom('imports as i')
    .leftJoin('users as u', 'u.id', 'i.created_by')
    .leftJoin('lists as li', 'li.id', 'i.list_id')
    .select([
      'i.id',
      'i.status',
      'i.file_name',
      'i.created_at',
      'i.finished_at',
      'i.error',
      'i.summary',
      'i.created_by',
      'u.name as user_name',
      'li.id as list_id',
      'li.name as list_name',
    ])
    .where('i.status', 'in', ['concluida', 'falhou', 'processando'])
    .orderBy('i.created_at', 'desc')
    .limit(30)
    .execute();
  return rows.map(toState);
}

/** CSV com as linhas que não entraram e o motivo de cada uma. */
export async function rejectedCsv(db: Db, id: string): Promise<{ fileName: string; body: string }> {
  const imp = await loadImport(db, id);
  const summary = (imp.summary ?? {}) as { headerLabels?: string[] };
  const rows = await db
    .selectFrom('import_rejections')
    .select(['row_number', 'reason', 'values'])
    .where('import_id', '=', id)
    .orderBy('row_number')
    .execute();
  const width = Math.max(summary.headerLabels?.length ?? 0, ...rows.map((r) => r.values.length));
  const labels = Array.from({ length: width }, (_, i) => summary.headerLabels?.[i] ?? `Coluna ${i + 1}`);
  let body = CSV_BOM + csvLine(['Linha', 'Motivo', ...labels]);
  for (const r of rows) body += csvLine([r.row_number, r.reason, ...r.values]);
  const base =
    imp.file_name
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w-]+/g, '-')
      .slice(0, 40) || 'importacao';
  return { fileName: `rejeitados-${base}.csv`, body };
}

export async function discardImport(db: Db, id: string): Promise<void> {
  const imp = await loadImport(db, id);
  if (imp.status === 'concluida' || imp.status === 'processando') {
    throw conflict('Esta importação já foi concluída ou está em andamento.');
  }
  await db
    .updateTable('imports')
    .set({ status: 'descartada', file_data: null })
    .where('id', '=', id)
    .execute();
  forgetTables(id);
}

/**
 * Tira importações do histórico ("Importações recentes"): some o registro, o arquivo guardado e as linhas
 * recusadas. As listas e os leads importados continuam. Importação em andamento não sai.
 * Sem ids, limpa todas as que já terminaram.
 */
export async function clearImports(
  db: Db,
  user: AuthUser,
  ids: string[] | undefined,
  ip: string | null,
): Promise<{ removed: number }> {
  if (ids && !ids.length) return { removed: 0 };
  let query = db.deleteFrom('imports').where('status', 'in', ['concluida', 'falhou', 'descartada']);
  if (ids) query = query.where('id', 'in', ids);
  const r = await query.executeTakeFirst();
  const removed = Number(r.numDeletedRows);
  if (removed > 0) {
    await audit(db, {
      userId: user.id,
      action: 'limpou_importacoes',
      entity: 'importacao',
      details: { quantidade: removed, ...(ids ? {} : { tudo: true }) },
      ip,
    });
  }
  return { removed };
}

/** Importações que ficaram "processando" porque o servidor reiniciou no meio viram "falhou" (nada foi gravado). */
export async function recoverStaleImports(db: Db, olderThanMinutes = 2): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const got = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(${IMPORT_LOCK}) AS ok`.execute(
      trx,
    );
    if (!got.rows[0]?.ok) return 0;
    const r = await trx
      .updateTable('imports')
      .set({
        status: 'falhou',
        error: 'O servidor reiniciou durante a importação. Nada foi gravado; tente de novo.',
        finished_at: sql`now()`,
      })
      .where('status', '=', 'processando')
      .where('started_at', '<', sql<Date>`now() - make_interval(mins => ${olderThanMinutes}::int)`)
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
  });
}
