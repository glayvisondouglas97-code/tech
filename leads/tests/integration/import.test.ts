import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { importTestHooks } from '../../src/server/modules/imports/service';
import type { ImportDraft, ImportOptions, ImportState } from '../../src/shared/api';
import { acceptanceRows, multipart, toXlsx } from '../fixtures';
import { type Client, countRows, createTestApp, createUser, loginAs, type TestApp } from '../helpers';

let t: TestApp;
let admin: Client;
let users: { ana: string; bruno: string };

beforeAll(async () => {
  t = await createTestApp();
  const g = await createUser(t.db, { name: 'Gestora', role: 'admin' });
  const a = await createUser(t.db, { name: 'Ana', role: 'atendente' });
  const b = await createUser(t.db, { name: 'Bruno', role: 'atendente' });
  users = { ana: a.id, bruno: b.id };
  admin = await loginAs(t.app, g);
});
afterAll(async () => t.close());
afterEach(() => {
  importTestHooks.afterLeadsInserted = undefined;
});

async function upload(c: Client, fileName: string, data: Buffer): Promise<ImportDraft> {
  const mp = multipart(fileName, data);
  const r = await c.request('POST', '/api/imports/upload', mp.body, mp.headers);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

async function waitDone(c: Client, id: string): Promise<ImportState> {
  for (let i = 0; i < 200; i++) {
    const s: ImportState = (await c.get(`/api/imports/${id}`)).json();
    if (s.status !== 'processando') return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('importação não terminou');
}

function opts(draft: ImportDraft, extra: Partial<ImportOptions> = {}): ImportOptions {
  return { ...draft.suggestion, listName: 'Lista de teste', ...extra };
}

describe('importação de planilha (.xlsx com 1.000 linhas)', () => {
  let draft: ImportDraft;

  it('detecta cabeçalho e colunas e mostra a prévia com os números certos', async () => {
    const { rows, summary } = acceptanceRows();
    draft = await upload(admin, 'leads-setembro.xlsx', toXlsx(rows));
    expect(draft.rowCount).toBe(1001);
    expect(draft.suggestion).toMatchObject({
      hasHeader: true,
      companyColumn: 0,
      nameColumn: 1,
      phoneColumn: 2,
    });
    expect(draft.columns.map((c) => c.label)).toEqual(['Empresa', 'Sócio', 'Celular', 'Cidade', 'Interesse']);
    expect(draft.suggestion.listName).toBe('leads-setembro');

    const r = await admin.post(`/api/imports/${draft.id}/preview`, opts(draft));
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json();
    expect(p.counts).toEqual({
      total: summary.rows,
      valid: summary.valid,
      invalid: summary.invalid,
      duplicatesInFile: summary.duplicatesInFile,
      duplicatesInBase: 0,
      blocked: 0,
      // 450 empresas com 2 sócios cada; algumas linhas "Repetida" vêm antes da original e entram no lugar dela.
      companies: expect.any(Number),
      phones: 900,
    });
    expect(p.counts.companies).toBeGreaterThanOrEqual(450);
    expect(p.counts.companies).toBeLessThanOrEqual(510);
    expect(p.validSample[0].company).toMatch(/Ltda|ME$/);
    expect(p.extraColumns).toEqual(['Cidade', 'Interesse']);
    expect(p.validSample[0].phoneDisplay).toMatch(/^\(41\) 9\d{4}-\d{4}$/);
    expect(p.rejectedSample.length).toBeGreaterThan(0);
    // prévia não grava nada
    expect(await countRows(t.db, 'leads')).toBe(0);
  });

  it('confirma, grava tudo de uma vez e registra o histórico', async () => {
    const r = await admin.post(`/api/imports/${draft.id}/commit`, opts(draft, { listName: 'Setembro' }));
    expect(r.statusCode, r.body).toBe(200);
    const done = await waitDone(admin, draft.id);
    expect(done.status).toBe('concluida');
    expect(done.counts?.valid).toBe(900);
    expect(done.rejectedCount).toBe(100);
    expect(done.list?.name).toBe('Setembro');
    expect(await countRows(t.db, 'leads')).toBe(900);
    const events = await t.db
      .selectFrom('lead_events')
      .select('type')
      .where('type', '=', 'importado')
      .execute();
    expect(events).toHaveLength(900);
    const lead = await t.db.selectFrom('leads').selectAll().limit(1).executeTakeFirstOrThrow();
    expect(lead.phone).toMatch(/^55419\d{8}$/);
    expect(lead.extra).toEqual({ Cidade: 'Curitiba', Interesse: 'Plano' });
    expect(lead.status).toBe('pendente');
    expect(lead.assigned_to).toBeNull();
  });

  it('baixa as linhas rejeitadas com o motivo', async () => {
    const r = await admin.get(`/api/imports/${draft.id}/rejeitados.csv`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    const text = r.body;
    expect(text.startsWith('﻿Linha;Motivo;Empresa;Sócio;Celular;Cidade;Interesse\r\n')).toBe(true);
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(101);
    expect(text).toMatch(/Repetido no arquivo \(mesmo telefone da linha \d+\)/);
    expect(text).toMatch(/;Sem telefone;/);
    expect(text).toMatch(/;Telefone inválido;/);
  });

  it('confirmar de novo não duplica (idempotente)', async () => {
    const again = await admin.post(`/api/imports/${draft.id}/commit`, opts(draft));
    expect(again.json().status).toBe('concluida');
    expect(await countRows(t.db, 'lists')).toBe(1);
    expect(await countRows(t.db, 'leads')).toBe(900);
  });

  it('o mesmo arquivo de novo avisa e pula quem já está na base', async () => {
    const d2 = await upload(admin, 'leads-setembro.xlsx', toXlsx(acceptanceRows().rows));
    expect(d2.previous?.listName).toBe('Setembro');
    const p = (await admin.post(`/api/imports/${d2.id}/preview`, opts(d2))).json();
    expect(p.counts.valid).toBe(0);
    expect(p.counts.duplicatesInBase).toBe(900);
    expect(p.counts.duplicatesInFile).toBe(60);
    const pend = (
      await admin.post(`/api/imports/${d2.id}/preview`, opts(d2, { dedupeBase: 'nenhum' }))
    ).json();
    expect(pend.counts.valid).toBe(900);
    await admin.delete(`/api/imports/${d2.id}`);
  });
});

describe('robustez', () => {
  it('se falhar no meio, não sobra lista pela metade; tentar de novo funciona', async () => {
    const before = { lists: await countRows(t.db, 'lists'), leads: await countRows(t.db, 'leads') };
    const rows = [
      ['Nome', 'Telefone'],
      ...Array.from({ length: 2500 }, (_, i) => [`Falha ${i}`, `419${String(60_000_000 + i)}`]),
    ];
    const d = await upload(admin, 'falha.xlsx', toXlsx(rows));
    importTestHooks.afterLeadsInserted = () => {
      throw new Error('queda simulada');
    };
    await admin.post(`/api/imports/${d.id}/commit`, opts(d, { listName: 'Vai falhar' }));
    const failed = await waitDone(admin, d.id);
    expect(failed.status).toBe('falhou');
    expect(failed.error).toMatch(/Nada foi importado/);
    expect(await countRows(t.db, 'lists')).toBe(before.lists);
    expect(await countRows(t.db, 'leads')).toBe(before.leads);

    importTestHooks.afterLeadsInserted = undefined;
    await admin.post(`/api/imports/${d.id}/commit`, opts(d, { listName: 'Agora vai' }));
    const ok = await waitDone(admin, d.id);
    expect(ok.status).toBe('concluida');
    expect(await countRows(t.db, 'leads')).toBe(before.leads + 2500);
  });

  it('dois cliques simultâneos em confirmar criam uma lista só', async () => {
    const rows = [
      ['Nome', 'Telefone'],
      ...Array.from({ length: 300 }, (_, i) => [`Duplo ${i}`, `419${String(50_000_000 + i)}`]),
    ];
    const d = await upload(admin, 'duplo.csv', Buffer.from(rows.map((r) => r.join(';')).join('\n')));
    const listsBefore = await countRows(t.db, 'lists');
    await Promise.all(
      [1, 2, 3].map(() => admin.post(`/api/imports/${d.id}/commit`, opts(d, { listName: 'Duplo' }))),
    );
    expect((await waitDone(admin, d.id)).status).toBe('concluida');
    expect(await countRows(t.db, 'lists')).toBe(listsBefore + 1);
  });
});

describe('distribuição, CSV, colar e não contatar', () => {
  it('divide igualmente entre os atendentes escolhidos', async () => {
    const rows = [
      ['Nome', 'Telefone'],
      ...Array.from({ length: 11 }, (_, i) => [`Div ${i}`, `419${String(40_000_000 + i)}`]),
    ];
    const d = await upload(admin, 'dividir.xlsx', toXlsx(rows));
    const o = opts(d, {
      listName: 'Dividida',
      distribution: { mode: 'dividir', userIds: [users.ana, users.bruno] },
    });
    const p = (await admin.post(`/api/imports/${d.id}/preview`, o)).json();
    expect(p.perAttendant.map((x: { count: number }) => x.count)).toEqual([6, 5]);
    await admin.post(`/api/imports/${d.id}/commit`, o);
    const s = await waitDone(admin, d.id);
    const counts = await t.db
      .selectFrom('leads')
      .select(['assigned_to', (eb) => eb.fn.countAll<number>().as('n')])
      .where('list_id', '=', s.list?.id as string)
      .groupBy('assigned_to')
      .execute();
    expect(Object.fromEntries(counts.map((c) => [c.assigned_to, c.n]))).toEqual({
      [users.ana]: 6,
      [users.bruno]: 5,
    });
  });

  it('atribui tudo a uma pessoa', async () => {
    const d = await upload(
      admin,
      'pessoa.csv',
      Buffer.from('Nome;Telefone\nX;41 93000-0001\nY;41 93000-0002'),
    );
    await admin.post(
      `/api/imports/${d.id}/commit`,
      opts(d, { listName: 'Só Ana', distribution: { mode: 'pessoa', userId: users.ana } }),
    );
    const s = await waitDone(admin, d.id);
    const rows = await t.db
      .selectFrom('leads')
      .select(['assigned_to', 'assigned_via'])
      .where('list_id', '=', s.list?.id as string)
      .execute();
    expect(rows.every((r) => r.assigned_to === users.ana && r.assigned_via === 'importacao')).toBe(true);
  });

  it('lê CSV do Excel em Windows-1252 com ; e aplica DDD padrão', async () => {
    const csv = Buffer.from(
      'Nome;Telefone;Observação\nJos\xe9 Concei\xe7\xe3o;98765-1234;Cliente antigo\n',
      'latin1',
    );
    const d = await upload(admin, 'antigo.csv', csv);
    expect(d.columns.map((c) => c.label)).toEqual(['Nome', 'Telefone', 'Observação']);
    const sem = (await admin.post(`/api/imports/${d.id}/preview`, opts(d))).json();
    expect(sem.counts.invalid).toBe(1);
    expect(sem.rejectedSample[0].reason).toMatch(/sem DDD/);
    const com = (await admin.post(`/api/imports/${d.id}/preview`, opts(d, { defaultDdd: '11' }))).json();
    expect(com.validSample[0]).toMatchObject({ name: 'José Conceição', phoneDisplay: '(11) 98765-1234' });
  });

  it('aceita linhas coladas (tabulação) sem cabeçalho', async () => {
    const r = await admin.post('/api/imports/paste', {
      text: 'Maria Silva\t(41) 99111-2233\nJoão\t41 99111-4455',
    });
    expect(r.statusCode, r.body).toBe(200);
    const d: ImportDraft = r.json();
    expect(d.suggestion).toMatchObject({ hasHeader: false, nameColumn: 0, phoneColumn: 1 });
    const p = (await admin.post(`/api/imports/${d.id}/preview`, opts(d))).json();
    expect(p.counts.valid).toBe(2);
  });

  it('números na lista de não contatar nunca entram', async () => {
    expect(
      (await admin.post('/api/blocklist', { phone: '(41) 99222-0001', reason: 'Pediu' })).statusCode,
    ).toBe(200);
    const d = await upload(admin, 'bloq.csv', Buffer.from('Nome;Telefone\nA;41 99222-0001\nB;41 99222-0002'));
    const p = (await admin.post(`/api/imports/${d.id}/preview`, opts(d))).json();
    expect(p.counts).toMatchObject({ valid: 1, blocked: 1 });
  });

  it('escolhe outra aba da planilha', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Resumo'], ['nada aqui']]), 'Resumo');
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Cliente', 'Fone'],
        ['Ana', '41 99333-0001'],
      ]),
      'Contatos',
    );
    const d = await upload(
      admin,
      'abas.xlsx',
      XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
    );
    expect(d.sheets).toEqual(['Resumo', 'Contatos']);
    const r = (await admin.post(`/api/imports/${d.id}/detect`, { sheet: 'Contatos' })).json();
    expect(r.sheet).toBe('Contatos');
    expect(r.suggestion).toMatchObject({ hasHeader: true, nameColumn: 0, phoneColumn: 1 });
  });

  it('recusa arquivo inválido com mensagem clara', async () => {
    const mp = multipart('foto.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await admin.request('POST', '/api/imports/upload', mp.body, mp.headers);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/Formato não aceito/);
  });
});
