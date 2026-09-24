import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expireStaleLeads } from '../../src/server/jobs/scheduler';
import type { LeadDetail, LeadItem } from '../../src/shared/api';
import { type Client, createTestApp, createUser, loginAs, seedList, type TestApp } from '../helpers';

let t: TestApp;
let admin: Client;
let ana: Client;
let bruno: Client;
let ids: { admin: string; ana: string; bruno: string };

beforeAll(async () => {
  t = await createTestApp();
  const g = await createUser(t.db, { name: 'Gestora', role: 'dono' });
  const a = await createUser(t.db, { name: 'Ana', role: 'atendente' });
  const b = await createUser(t.db, { name: 'Bruno', role: 'atendente' });
  ids = { admin: g.id, ana: a.id, bruno: b.id };
  admin = await loginAs(t.app, g);
  ana = await loginAs(t.app, a);
  bruno = await loginAs(t.app, b);
});
afterAll(async () => t.close());

async function detail(c: Client, id: number): Promise<LeadDetail> {
  const r = await c.get(`/api/leads/${id}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

describe('fluxo do atendente', () => {
  let lead: LeadItem;

  it('pega leads, vê contadores e a fila', async () => {
    await seedList(t.db, { count: 30, phoneStart: 0 });
    const before = (await ana.get('/api/queue/stats')).json();
    expect(before).toMatchObject({ minhaFila: 0, livres: 30, chameiHoje: 0, pullSize: 10 });
    const pull = (await ana.post('/api/queue/pull')).json();
    expect(pull.count).toBe(10);
    const q = (await ana.get('/api/queue')).json();
    expect(q.total).toBe(10);
    lead = q.items[0];
    expect(lead.phoneDisplay).toMatch(/^\(41\) 98\d{3}-\d{4}$/);
    expect(lead.extra).toEqual({ Cidade: 'Curitiba' });
    expect(lead.list.name).toBe('Lista de teste');
    expect((await ana.get('/api/queue/stats')).json()).toMatchObject({ minhaFila: 10, livres: 20 });
  });

  it('busca na fila por nome e por telefone', async () => {
    const byName = (await ana.get(`/api/queue?q=${encodeURIComponent(lead.name)}`)).json();
    expect(byName.items.map((l: LeadItem) => l.id)).toContain(lead.id);
    const byPhone = (await ana.get(`/api/queue?q=${encodeURIComponent(lead.phoneDisplay)}`)).json();
    expect(byPhone.items.map((l: LeadItem) => l.id)).toEqual([lead.id]);
  });

  it('abre o WhatsApp, marca como chamado, desfaz e chama de novo, sem perder histórico', async () => {
    expect((await ana.post(`/api/leads/${lead.id}/whatsapp`)).json()).toEqual({ ok: true, warning: null });
    const called = await ana.post(`/api/leads/${lead.id}/call`, { result: 'enviado' });
    expect(called.statusCode).toBe(200);
    expect(called.json()).toMatchObject({
      status: 'chamado',
      result: 'enviado',
      calledBy: { id: ids.ana, name: 'Ana' },
    });
    expect((await ana.get('/api/queue/stats')).json()).toMatchObject({ minhaFila: 9, chameiHoje: 1 });

    const again = await ana.post(`/api/leads/${lead.id}/call`, { result: 'enviado' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/já foi marcado como chamado por Ana/);

    const undone = await ana.post(`/api/leads/${lead.id}/undo`);
    expect(undone.json()).toMatchObject({ status: 'pendente', result: null, assignedTo: { id: ids.ana } });

    await ana.post(`/api/leads/${lead.id}/call`, { result: 'interessado', note: 'Quer orçamento' });
    const d = await detail(ana, lead.id);
    expect(d.lead).toMatchObject({ result: 'interessado', note: 'Quer orçamento' });
    // Histórico completo, do mais antigo para o mais novo: nada se perde ao desfazer e chamar de novo.
    expect(d.events.map((e) => e.type).reverse()).toEqual([
      'pegou',
      'abriu_whatsapp',
      'chamado',
      'desfeito',
      'chamado',
      'observacao',
    ]);
    expect(d.events.every((e) => e.user?.name === 'Ana')).toBe(true);
  });

  it('marca "Sem WhatsApp", que não conta como chamado nas métricas', async () => {
    const q = (await ana.get('/api/queue')).json();
    const id = q.items[0].id;
    await ana.post(`/api/leads/${id}/call`, { result: 'sem_whatsapp' });
    const stats = (await ana.get('/api/queue/stats')).json();
    expect(stats).toMatchObject({ chameiHoje: 1, semWhatsappHoje: 1 });
  });

  it('edição com versão antiga é recusada (não apaga a mudança de outra pessoa)', async () => {
    const d = await detail(ana, lead.id);
    const v = d.lead.version;
    const byAdmin = await admin.patch(`/api/leads/${lead.id}`, { version: v, result: 'fechou' });
    expect(byAdmin.statusCode).toBe(200);
    const stale = await ana.patch(`/api/leads/${lead.id}`, { version: v, note: 'sobrescrever' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().lead.result).toBe('fechou');
    const fresh = await ana.patch(`/api/leads/${lead.id}`, {
      version: stale.json().lead.version,
      note: 'agora sim',
    });
    expect(fresh.json()).toMatchObject({ result: 'fechou', note: 'agora sim' });
    const types = (await detail(admin, lead.id)).events.map((e) => e.type);
    expect(types).toContain('resultado');
  });

  it('agenda e conclui retorno', async () => {
    const d = await detail(ana, lead.id);
    const when = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const r = await ana.patch(`/api/leads/${lead.id}`, { version: d.lead.version, callbackAt: when });
    expect(r.json().callbackAt).toBe(when);
    const q = (await ana.get('/api/queue')).json();
    expect(q.callbacks.map((l: LeadItem) => l.id)).toContain(lead.id);
    const done = await ana.patch(`/api/leads/${lead.id}`, {
      version: r.json().version,
      callbackAt: null,
      result: 'respondeu',
    });
    expect(done.json().callbackAt).toBeNull();
    expect((await ana.get('/api/queue')).json().callbacks).toHaveLength(0);
  });

  it('"Já chamados" mostra quem chamou e quando, com filtros', async () => {
    const mine = (await ana.get('/api/leads?view=chamados&period=hoje')).json();
    expect(mine.total).toBe(2);
    expect(mine.items[0].calledBy.name).toBe('Ana');
    expect(mine.items[0].calledAt).toBeTruthy();
    const onlyNoWa = (await admin.get('/api/leads?view=chamados&result=sem_whatsapp')).json();
    expect(onlyNoWa.total).toBe(1);
    const byAttendant = (await admin.get(`/api/leads?view=chamados&attendant=${ids.bruno}`)).json();
    expect(byAttendant.total).toBe(0);
    const custom = (
      await admin.get('/api/leads?view=chamados&period=personalizado&from=2000-01-01&to=2000-01-02')
    ).json();
    expect(custom.total).toBe(0);
  });

  it('devolve à fila livre e chama de novo pela própria fila', async () => {
    const back = await ana.post(`/api/leads/${lead.id}/requeue`, { to: 'minha' });
    expect(back.json()).toMatchObject({
      status: 'pendente',
      assignedTo: { id: ids.ana },
      result: null,
      note: 'agora sim',
    });
    const free = await ana.post(`/api/leads/${lead.id}/requeue`, { to: 'livre' });
    expect(free.json()).toMatchObject({ status: 'pendente', assignedTo: null });
    expect((await ana.get(`/api/leads/${lead.id}`)).statusCode).toBe(404);
    const types = (await detail(admin, lead.id)).events.map((e) => e.type);
    expect(types).toContain('devolvido');
    expect(types.filter((x) => x === 'chamado')).toHaveLength(2);
  });

  it('"não quero mais contato" bloqueia o número e tira da fila todos os leads com ele', async () => {
    const q = (await ana.get('/api/queue')).json();
    const target: LeadItem = q.items[0];
    // mesmo telefone em outra lista, livre
    const other = await t.db
      .insertInto('lists')
      .values({ name: 'Outra', distribution: 'fila' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const dup = await t.db
      .insertInto('leads')
      .values({ list_id: other.id, row_number: 2, name: 'Mesmo número', phone: target.phone })
      .returning('id')
      .executeTakeFirstOrThrow();
    const r = await ana.post(`/api/leads/${target.id}/optout`, { reason: 'Pediu no WhatsApp' });
    expect(r.json().status).toBe('bloqueado');
    const dupRow = await t.db
      .selectFrom('leads')
      .select('status')
      .where('id', '=', dup.id)
      .executeTakeFirstOrThrow();
    expect(dupRow.status).toBe('bloqueado');
    expect(
      await t.db
        .selectFrom('blocked_phones')
        .select('phone')
        .where('phone', '=', target.phone)
        .executeTakeFirst(),
    ).toBeTruthy();
    // nunca volta para a fila
    const pulled = (await bruno.post('/api/queue/pull')).json();
    expect(pulled.leads.map((l: LeadItem) => l.phone)).not.toContain(target.phone);
    // desbloquear (admin) devolve à fila livre
    await admin.post('/api/blocklist/remove', { phone: target.phone });
    const after = await t.db
      .selectFrom('leads')
      .select(['status', 'assigned_to'])
      .where('id', '=', dup.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ status: 'pendente', assigned_to: null });
  });

  it('avisa quando o atendente abre conversas rápido demais', async () => {
    await t.db.updateTable('settings').set({ hourly_contact_warning: 3 }).execute();
    const q = (await bruno.get('/api/queue')).json();
    const results = [];
    for (const l of q.items.slice(0, 3))
      results.push((await bruno.post(`/api/leads/${l.id}/whatsapp`)).json());
    expect(results[0].warning).toBeNull();
    expect(results[2].warning).toMatch(/3 conversas na última hora/);
    await t.db.updateTable('settings').set({ hourly_contact_warning: 60 }).execute();
  });
});

describe('operações do gestor', () => {
  it('redistribui a fila de um atendente entre outros', async () => {
    await t.db
      .updateTable('leads')
      .set({ assigned_to: null, assigned_at: null })
      .where('status', '=', 'pendente')
      .execute();
    const { leadIds } = await seedList(t.db, { count: 9, assignTo: ids.bruno, phoneStart: 1000 });
    const r = await admin.post('/api/leads/redistribute', { from: ids.bruno, to: [ids.ana, ids.admin] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().moved).toBe(9);
    expect(r.json().perUser.map((p: { count: number }) => p.count)).toEqual([5, 4]);
    const rows = await t.db.selectFrom('leads').select('assigned_to').where('id', 'in', leadIds).execute();
    expect(rows.filter((x) => x.assigned_to === ids.bruno)).toHaveLength(0);
  });

  it('atribui e devolve em lote', async () => {
    const { leadIds } = await seedList(t.db, { count: 4, phoneStart: 2000 });
    const a = (
      await admin.post('/api/leads/bulk', { ids: leadIds, action: 'atribuir', userId: ids.bruno })
    ).json();
    expect(a).toEqual({ moved: 4, skipped: 0 });
    const d = (await admin.post('/api/leads/bulk', { ids: leadIds, action: 'devolver' })).json();
    expect(d).toEqual({ moved: 4, skipped: 0 });
  });

  it('devolve leads parados e expira automaticamente os que ninguém abriu', async () => {
    const { leadIds } = await seedList(t.db, { count: 3, phoneStart: 3000 });
    await t.db
      .updateTable('leads')
      .set({ assigned_to: ids.ana, assigned_via: 'pegou', assigned_at: sql`now() - interval '50 hours'` })
      .where('id', 'in', leadIds)
      .execute();
    await t.db
      .updateTable('leads')
      .set({ whatsapp_opened_at: sql`now()` })
      .where('id', '=', leadIds[0] as number)
      .execute();
    await t.db.updateTable('settings').set({ expire_hours: 48 }).execute();
    expect(await expireStaleLeads(t.db)).toBe(2);
    const rows = await t.db
      .selectFrom('leads')
      .select(['id', 'assigned_to'])
      .where('id', 'in', leadIds)
      .orderBy('id')
      .execute();
    expect(rows.map((r) => r.assigned_to)).toEqual([ids.ana, null, null]);
    const ev = await t.db
      .selectFrom('lead_events')
      .select(['type', 'user_id'])
      .where('lead_id', '=', leadIds[1] as number)
      .where('type', '=', 'expirado')
      .execute();
    expect(ev).toEqual([{ type: 'expirado', user_id: null }]);
    const released = (await admin.post('/api/leads/release', { userId: ids.ana, olderThanHours: 24 })).json();
    expect(released.released).toBeGreaterThanOrEqual(1);
  });

  it('desativar atendente devolve os leads dele para a fila livre', async () => {
    const extra = await createUser(t.db, { name: 'Temporário', role: 'atendente' });
    const { leadIds } = await seedList(t.db, { count: 3, assignTo: extra.id, phoneStart: 4000 });
    const r = (await admin.post(`/api/users/${extra.id}/active`, { active: false })).json();
    expect(r.released).toBe(3);
    const rows = await t.db.selectFrom('leads').select('assigned_to').where('id', 'in', leadIds).execute();
    expect(rows.every((x) => x.assigned_to === null)).toBe(true);
  });

  it('arquiva e exclui lista (com confirmação pelo nome)', async () => {
    const { listId, leadIds } = await seedList(t.db, { name: 'Para excluir', count: 2, phoneStart: 5000 });
    expect((await admin.post(`/api/lists/${listId}/archive`, { archived: true })).statusCode).toBe(200);
    const lists = (await admin.get('/api/lists')).json();
    expect(lists.map((l: { id: string }) => l.id)).not.toContain(listId);
    expect((await admin.get('/api/lists?archived=1')).json().map((l: { id: string }) => l.id)).toContain(
      listId,
    );
    expect((await admin.post(`/api/lists/${listId}/delete`, { confirm: 'outro nome' })).statusCode).toBe(400);
    expect((await admin.post(`/api/lists/${listId}/delete`, { confirm: 'para excluir' })).statusCode).toBe(
      200,
    );
    expect(await t.db.selectFrom('leads').select('id').where('id', 'in', leadIds).execute()).toHaveLength(0);
  });
});
