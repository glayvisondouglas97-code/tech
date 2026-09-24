import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, createTestApp, createUser, loginAs, seedList, type TestApp } from '../helpers';

let t: TestApp;
let ana: Client;
let bruno: Client;
let supervisor: Client;
let admin: Client;
let anaLead: number;
let brunoLead: number;
let brunoCalled: number;
let freeLead: number;
let ids: { ana: string; bruno: string };

beforeAll(async () => {
  t = await createTestApp();
  const a = await createUser(t.db, { name: 'Ana', role: 'atendente' });
  const b = await createUser(t.db, { name: 'Bruno', role: 'atendente' });
  const s = await createUser(t.db, { name: 'Sérgio', role: 'supervisor' });
  const g = await createUser(t.db, { name: 'Gestora', role: 'admin' });
  ids = { ana: a.id, bruno: b.id };
  anaLead = (await seedList(t.db, { count: 1, assignTo: a.id, phoneStart: 0 })).leadIds[0] as number;
  const bl = await seedList(t.db, { count: 2, assignTo: b.id, phoneStart: 10 });
  brunoLead = bl.leadIds[0] as number;
  brunoCalled = bl.leadIds[1] as number;
  freeLead = (await seedList(t.db, { count: 1, phoneStart: 20 })).leadIds[0] as number;
  ana = await loginAs(t.app, a);
  bruno = await loginAs(t.app, b);
  supervisor = await loginAs(t.app, s);
  admin = await loginAs(t.app, g);
  const r = await bruno.post(`/api/leads/${brunoCalled}/call`, {
    result: 'interessado',
    note: 'Quer proposta',
  });
  expect(r.statusCode).toBe(200);
});
afterAll(async () => t.close());

describe('atendente não vê nem altera leads de outro atendente (nem pela API)', () => {
  it('detalhe, ações e edição devolvem 404', async () => {
    for (const id of [brunoLead, brunoCalled, freeLead]) {
      expect((await ana.get(`/api/leads/${id}`)).statusCode, `GET ${id}`).toBe(404);
      expect((await ana.post(`/api/leads/${id}/whatsapp`)).statusCode).toBe(404);
      expect((await ana.post(`/api/leads/${id}/call`, { result: 'enviado' })).statusCode).toBe(404);
      expect((await ana.post(`/api/leads/${id}/undo`)).statusCode).toBe(404);
      expect((await ana.post(`/api/leads/${id}/requeue`, { to: 'minha' })).statusCode).toBe(404);
      expect((await ana.post(`/api/leads/${id}/requeue`, { to: 'livre' })).statusCode).toBe(404);
      expect((await ana.post(`/api/leads/${id}/optout`, {})).statusCode).toBe(404);
      expect((await ana.patch(`/api/leads/${id}`, { version: 1, note: 'invasão' })).statusCode).toBe(404);
    }
    const lead = await t.db
      .selectFrom('leads')
      .selectAll()
      .where('id', '=', brunoCalled)
      .executeTakeFirstOrThrow();
    expect(lead.note).toBe('Quer proposta');
    expect(lead.called_by).toBe(ids.bruno);
  });

  it('listagens trazem só os leads dela', async () => {
    const q = (await ana.get('/api/queue')).json();
    expect(q.items.map((l: { id: number }) => l.id)).toEqual([anaLead]);
    const called = (await ana.get('/api/leads?view=chamados&period=tudo')).json();
    expect(called.total).toBe(0);
    // Filtro por outro atendente não fura a regra
    const other = (await ana.get(`/api/leads?view=chamados&period=tudo&attendant=${ids.bruno}`)).json();
    expect(other.total).toBe(0);
    expect((await ana.get('/api/leads?view=todos')).statusCode).toBe(403);
    const search = (await ana.get('/api/leads?view=chamados&period=tudo&q=Cliente')).json();
    expect(search.total).toBe(0);
  });

  it('o painel mostra só os números dela', async () => {
    const d = (await ana.get('/api/dashboard')).json();
    expect(d.perAttendant.map((p: { user: { id: string } }) => p.user.id)).toEqual([ids.ana]);
    expect(d.lists).toEqual([]);
    expect(d.totals.leads).toBe(0);
  });

  it('não acessa nenhuma tela de gestão', async () => {
    const forbidden: [string, string, unknown?][] = [
      ['GET', '/api/users'],
      ['POST', '/api/users', { name: 'X', email: 'x@x.com', role: 'admin' }],
      ['PATCH', `/api/users/${ids.ana}`, { role: 'admin' }],
      ['POST', `/api/users/${ids.bruno}/active`, { active: false }],
      ['POST', `/api/users/${ids.bruno}/password-link`],
      ['GET', '/api/settings'],
      [
        'PUT',
        '/api/settings',
        {
          companyName: 'X',
          pullSize: 10,
          maxQueue: 0,
          expireHours: 0,
          hourlyContactWarning: 0,
          defaultDdd: null,
        },
      ],
      ['POST', '/api/templates', { name: 'X', body: 'Y' }],
      ['GET', '/api/blocklist'],
      ['POST', '/api/blocklist', { phone: '41999999999' }],
      ['GET', '/api/lists'],
      ['GET', '/api/team'],
      ['GET', '/api/imports'],
      ['POST', '/api/imports/paste', { text: 'Maria;41999999999' }],
      ['GET', '/api/export/leads.csv'],
      ['GET', '/api/export/leads.xlsx'],
      ['POST', '/api/leads/bulk', { ids: [brunoLead], action: 'devolver' }],
      ['POST', '/api/leads/redistribute', { from: ids.bruno, to: [ids.ana] }],
      ['POST', '/api/leads/release', {}],
      ['POST', '/api/privacy/search', { phone: '41999999999' }],
      ['GET', '/api/audit'],
    ];
    for (const [method, url, body] of forbidden) {
      const r = await ana.request(method as 'GET', url, body);
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    // nada mudou
    const b = await t.db
      .selectFrom('leads')
      .select('assigned_to')
      .where('id', '=', brunoLead)
      .executeTakeFirstOrThrow();
    expect(b.assigned_to).toBe(ids.bruno);
  });

  it('não consegue passar lead para outra pessoa', async () => {
    const r = await ana.post(`/api/leads/${anaLead}/requeue`, { to: ids.bruno });
    expect(r.statusCode).toBe(403);
  });
});

describe('supervisor e administrador', () => {
  it('supervisor acompanha tudo, importa e exporta, mas não mexe na configuração', async () => {
    expect((await supervisor.get(`/api/leads/${brunoCalled}`)).statusCode).toBe(200);
    expect((await supervisor.get('/api/leads?view=todos')).json().total).toBe(4);
    expect((await supervisor.get('/api/export/leads.csv?view=todos')).statusCode).toBe(200);
    expect((await supervisor.get('/api/imports')).statusCode).toBe(200);
    expect((await supervisor.get('/api/team')).statusCode).toBe(200);
    for (const url of ['/api/users', '/api/settings', '/api/audit', '/api/blocklist']) {
      expect((await supervisor.get(url)).statusCode, url).toBe(403);
    }
    expect(
      (await supervisor.post('/api/lists/00000000-0000-0000-0000-000000000000/archive', { archived: true }))
        .statusCode,
    ).toBe(403);
  });

  it('administrador acessa tudo', async () => {
    for (const url of [
      '/api/users',
      '/api/settings',
      '/api/audit',
      '/api/blocklist',
      '/api/lists',
      '/api/team',
    ]) {
      expect((await admin.get(url)).statusCode, url).toBe(200);
    }
  });

  it('gestor edita o resultado de lead de qualquer atendente', async () => {
    const lead = (await admin.get(`/api/leads/${brunoCalled}`)).json().lead;
    const r = await admin.patch(`/api/leads/${brunoCalled}`, { version: lead.version, result: 'fechou' });
    expect(r.statusCode).toBe(200);
    expect(r.json().result).toBe('fechou');
  });

  it('id inválido não quebra o servidor', async () => {
    expect((await admin.get('/api/leads/abc')).statusCode).toBe(404);
    expect((await admin.get('/api/leads/999999')).statusCode).toBe(404);
    expect((await admin.patch('/api/users/nao-e-uuid', { name: 'x' })).statusCode).toBe(404);
  });
});
