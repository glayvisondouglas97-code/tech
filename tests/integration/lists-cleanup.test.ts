import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportState } from '../../src/shared/api';
import { type Client, createTestApp, createUser, loginAs, seedList, type TestApp } from '../helpers';

/** Excluir várias listas de uma vez e limpar o histórico de importações. */

let t: TestApp;
let dono: Client;
let admin: Client;
let sup: Client;
let listA: string;
let listB: string;
let listC: string;
let leadA: number;

async function newImport(status: string, listId: string | null = null): Promise<string> {
  const r = await t.db
    .insertInto('imports')
    .values({
      status: status as 'concluida',
      source: 'arquivo',
      file_name: `planilha-${status}.xlsx`,
      file_sha256: `${status}-${Math.random()}`,
      file_size: 10,
      file_data: Buffer.from('xlsx'),
      list_id: listId,
      summary: JSON.stringify({ counts: { total: 3, valid: 2 } }),
      finished_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await t.db
    .insertInto('import_rejections')
    .values({ import_id: r.id, row_number: 3, reason: 'Telefone inválido', values: ['Maria', '123'] })
    .execute();
  return r.id;
}
const count = async (table: 'leads' | 'lists' | 'imports' | 'import_rejections' | 'lead_events') =>
  Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(t.db)).rows[0]?.n);

beforeAll(async () => {
  t = await createTestApp();
  const d = await createUser(t.db, { name: 'Dona', role: 'dono' });
  dono = await loginAs(t.app, d);
  admin = await loginAs(t.app, await createUser(t.db, { name: 'Gestora', role: 'admin' }));
  sup = await loginAs(t.app, await createUser(t.db, { name: 'Sílvia', role: 'supervisor' }));
  const a = await seedList(t.db, { name: 'Lista A', count: 5, createdBy: d.id });
  const b = await seedList(t.db, { name: 'Lista B', count: 3, createdBy: d.id, phoneStart: 100 });
  const c = await seedList(t.db, { name: 'Lista C', count: 2, createdBy: d.id, phoneStart: 200 });
  [listA, listB, listC] = [a.listId, b.listId, c.listId];
  leadA = a.leadIds[0] as number;
  await t.db
    .insertInto('lead_events')
    .values({ lead_id: leadA, type: 'importado', data: JSON.stringify({ lista: 'Lista A' }) })
    .execute();
});
afterAll(async () => t?.close());

describe('excluir várias listas', () => {
  it('só o dono exclui, e precisa digitar EXCLUIR', async () => {
    const body = { ids: [listA, listB], confirm: 'EXCLUIR' };
    expect((await admin.post('/api/lists/delete', body)).statusCode).toBe(403);
    expect((await sup.post('/api/lists/delete', body)).statusCode).toBe(403);
    const wrong = await dono.post('/api/lists/delete', { ids: [listA], confirm: 'Lista A' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe('Para excluir, digite EXCLUIR.');
    expect(await count('lists')).toBe(3);
  });

  it('apaga as listas escolhidas com os leads e o histórico; as outras ficam', async () => {
    const r = await dono.post('/api/lists/delete', { ids: [listA, listB], confirm: 'excluir' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ lists: 2, leads: 8 });
    expect(await count('lists')).toBe(1);
    expect(await count('leads')).toBe(2);
    expect(await count('lead_events')).toBe(0);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('details')
      .where('action', '=', 'excluiu_lista')
      .orderBy('id')
      .execute();
    expect(audit.map((a) => a.details)).toEqual(
      expect.arrayContaining([
        { lista: 'Lista A', leads: 5 },
        { lista: 'Lista B', leads: 3 },
      ]),
    );
  });

  it('lista que não existe mais: nada é apagado', async () => {
    const r = await dono.post('/api/lists/delete', { ids: [listA, listC], confirm: 'EXCLUIR' });
    expect(r.statusCode).toBe(404);
    expect(await count('lists')).toBe(1);
  });
});

describe('limpar o histórico de importações', () => {
  let done: string;
  let failed: string;
  let running: string;
  let draft: string;

  beforeAll(async () => {
    done = await newImport('concluida', listC);
    failed = await newImport('falhou');
    running = await newImport('processando');
    draft = await newImport('rascunho');
  });

  it('o supervisor não limpa; o administrador remove uma importação do histórico', async () => {
    expect((await sup.post('/api/imports/clear', {})).statusCode).toBe(403);
    const r = await admin.post('/api/imports/clear', { ids: [failed] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ removed: 1 });
    const list = (await admin.get('/api/imports')).json() as ImportState[];
    expect(list.map((i) => i.id).sort()).toEqual([done, running].sort());
  });

  it('"Limpar histórico" tira todas as terminadas; a lista e os leads continuam', async () => {
    const r = await admin.post('/api/imports/clear', {});
    expect(r.json()).toEqual({ removed: 1 });
    const left = await t.db.selectFrom('imports').select('id').orderBy('id').execute();
    expect(left.map((i) => i.id).sort()).toEqual([running, draft].sort());
    // As linhas recusadas das importações removidas saem junto; a lista importada fica.
    expect(await count('import_rejections')).toBe(2);
    expect(await count('lists')).toBe(1);
    expect(await count('leads')).toBe(2);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('details')
      .where('action', '=', 'limpou_importacoes')
      .orderBy('id')
      .execute();
    expect(audit.map((a) => a.details)).toEqual([{ quantidade: 1 }, { quantidade: 1, tudo: true }]);
  });

  it('importação em andamento não sai do histórico', async () => {
    expect((await admin.post('/api/imports/clear', { ids: [running] })).json()).toEqual({ removed: 0 });
    expect((await admin.get('/api/imports')).json().map((i: ImportState) => i.id)).toEqual([running]);
  });
});
