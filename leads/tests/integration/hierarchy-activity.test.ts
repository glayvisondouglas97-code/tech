import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivityItem, ActivitySummary, ListSummary, Page } from '../../src/shared/api';
import { type Client, createTestApp, createUser, loginAs, seedList, type TestApp } from '../helpers';

let t: TestApp;
let dono: Client;
let admin: Client;
let ana: Client;
let bruno: Client;
let ids: { dono: string; admin: string; ana: string; bruno: string; outroAdmin: string };

beforeAll(async () => {
  t = await createTestApp();
  const d = await createUser(t.db, { name: 'Dona', role: 'dono' });
  const g = await createUser(t.db, { name: 'Gestora', role: 'admin' });
  const g2 = await createUser(t.db, { name: 'Outro Admin', role: 'admin' });
  const a = await createUser(t.db, { name: 'Ana', role: 'atendente' });
  const b = await createUser(t.db, { name: 'Bruno', role: 'atendente' });
  ids = { dono: d.id, admin: g.id, ana: a.id, bruno: b.id, outroAdmin: g2.id };
  dono = await loginAs(t.app, d);
  admin = await loginAs(t.app, g);
  ana = await loginAs(t.app, a);
  bruno = await loginAs(t.app, b);
});
afterAll(async () => t.close());

describe('hierarquia: dono acima do administrador', () => {
  it('administrador gerencia atendentes, mas não administradores nem donos', async () => {
    expect(
      (await admin.post('/api/users', { name: 'Nova', email: 'nova@x.com', role: 'atendente' })).statusCode,
    ).toBe(200);
    expect(
      (await admin.post('/api/users', { name: 'Adm', email: 'adm@x.com', role: 'admin' })).statusCode,
    ).toBe(403);
    expect((await admin.post('/api/users', { name: 'Dn', email: 'dn@x.com', role: 'dono' })).statusCode).toBe(
      403,
    );
    expect((await admin.patch(`/api/users/${ids.ana}`, { role: 'admin' })).statusCode).toBe(403);
    expect((await admin.post(`/api/users/${ids.dono}/active`, { active: false })).statusCode).toBe(403);
    expect((await admin.post(`/api/users/${ids.outroAdmin}/password-link`)).statusCode).toBe(403);
    expect((await admin.patch(`/api/users/${ids.bruno}`, { dailyPullLimit: 5 })).statusCode).toBe(200);
  });

  it('só o dono exclui listas e usa a LGPD', async () => {
    const { listId } = await seedList(t.db, { name: 'Excluir', count: 1, phoneStart: 900 });
    expect((await admin.post(`/api/lists/${listId}/delete`, { confirm: 'Excluir' })).statusCode).toBe(403);
    expect((await admin.post('/api/privacy/search', { phone: '41980000900' })).statusCode).toBe(403);
    expect((await dono.post('/api/privacy/search', { phone: '41980000900' })).statusCode).toBe(200);
    expect((await dono.post(`/api/lists/${listId}/delete`, { confirm: 'Excluir' })).statusCode).toBe(200);
  });

  it('dono cria administrador e promove pessoas', async () => {
    const r = await dono.post('/api/users', { name: 'Adm Novo', email: 'admnovo@x.com', role: 'admin' });
    expect(r.statusCode).toBe(200);
    expect((await dono.patch(`/api/users/${ids.outroAdmin}`, { role: 'supervisor' })).statusCode).toBe(200);
  });
});

describe('pegar leads: quantidade, DDD e limite diário', () => {
  beforeAll(async () => {
    await t.db.updateTable('settings').set({ pull_size: 50, daily_pull_limit: 12 }).execute();
    // 30 leads do DDD 41 e 30 do DDD 11
    await seedList(t.db, { name: 'DDD 41', count: 30, phoneStart: 1000 });
    const other = await t.db
      .insertInto('lists')
      .values({ name: 'DDD 11', distribution: 'fila', total: 30 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('leads')
      .values(
        Array.from({ length: 30 }, (_, i) => ({
          list_id: other.id,
          row_number: i + 2,
          name: `Sócio ${i}`,
          company: `Empresa ${Math.floor(i / 3)} Ltda`,
          company_search: `empresa ${Math.floor(i / 3)} ltda`,
          phone: `55119${String(70_000_000 + i).padStart(8, '0')}`,
        })),
      )
      .execute();
  });

  it('mostra os DDDs livres e pega só do DDD escolhido, na quantidade escolhida', async () => {
    const ddds: { ddd: string; count: number }[] = (await ana.get('/api/queue/ddds')).json();
    expect(ddds).toEqual(
      expect.arrayContaining([
        { ddd: '11', count: 30 },
        { ddd: '41', count: 30 },
      ]),
    );
    const r = (await ana.post('/api/queue/pull', { quantity: 7, ddd: '11' })).json();
    expect(r.count).toBe(7);
    expect(
      r.leads.every(
        (l: { ddd: string; company: string }) => l.ddd === '11' && l.company.startsWith('Empresa'),
      ),
    ).toBe(true);
    const q = (await ana.get('/api/queue?ddd=11')).json();
    expect(q.total).toBe(7);
    expect(q.ddds).toEqual([{ ddd: '11', count: 7 }]);
  });

  it('respeita o limite diário padrão (12) e registra cada pedido', async () => {
    const r = (await ana.post('/api/queue/pull', { quantity: 20 })).json();
    expect(r.count).toBe(5);
    const blocked = await ana.post('/api/queue/pull', { quantity: 1 });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatch(/limite diário é 12/);
    expect((await ana.get('/api/queue/stats')).json()).toMatchObject({ pegouHoje: 12, limiteDiario: 12 });
    const pedidos = await t.db
      .selectFrom('audit_log')
      .select('details')
      .where('action', '=', 'pediu_leads')
      .where('user_id', '=', ids.ana)
      .orderBy('id')
      .execute();
    expect(pedidos.map((p) => p.details)).toEqual([
      { solicitados: 7, recebidos: 7, ddd: '11' },
      { solicitados: 20, recebidos: 5, ddd: 'todos' },
    ]);
  });

  it('limite individual vale mais que o padrão', async () => {
    // Bruno recebeu limite 5 no teste de hierarquia
    expect((await bruno.post('/api/queue/pull', { quantity: 50 })).json().count).toBe(5);
    expect((await bruno.post('/api/queue/pull')).statusCode).toBe(409);
  });

  it('lista mostra empresas, telefones e quanto falta pegar', async () => {
    const lists: ListSummary[] = (await admin.get('/api/lists')).json();
    const l11 = lists.find((l) => l.name === 'DDD 11') as ListSummary;
    expect(l11).toMatchObject({ total: 30, empresas: 10, telefones: 30, livres: 23 });
    expect(l11.empresasLivres).toBeLessThanOrEqual(10);
  });
});

describe('auditoria completa', () => {
  it('tentativa de acesso sem permissão fica registrada', async () => {
    expect((await ana.get('/api/users')).statusCode).toBe(403);
    const row = await t.db
      .selectFrom('audit_log')
      .select(['details'])
      .where('action', '=', 'acesso_negado')
      .where('user_id', '=', ids.ana)
      .executeTakeFirst();
    expect(row?.details).toMatchObject({ rota: '/api/users', metodo: 'GET' });
  });

  it('resumo por pessoa com ranking e quadro por dia', async () => {
    const q = (await ana.get('/api/queue')).json();
    await ana.post(`/api/leads/${q.items[0].id}/call`, { result: 'nao_correntista' });
    await ana.post(`/api/leads/${q.items[1].id}/call`, { result: 'sem_conta' });
    const s: ActivitySummary = (await admin.get('/api/activity/summary')).json();
    const byName = Object.fromEntries(s.users.map((u) => [u.user.name, u]));
    expect(byName.Ana).toMatchObject({ pedidos: 2, puxados: 12, chamados: 2, acessosNegados: 1 });
    expect(byName.Bruno).toMatchObject({ pedidos: 1, puxados: 5 });
    expect(s.topPuller?.user.name).toBe('Ana');
    expect(s.topCaller?.user.name).toBe('Ana');
    expect(s.daily.find((d) => d.user.name === 'Ana')).toMatchObject({ puxados: 12, chamados: 2 });
    expect((await ana.get('/api/activity/summary')).statusCode).toBe(403);
  });

  it('registro detalhado com filtro por pessoa e tipo; administrador não vê o dono', async () => {
    const feed: Page<ActivityItem> = (
      await admin.get(`/api/activity/feed?userId=${ids.ana}&category=pedidos`)
    ).json();
    expect(feed.total).toBe(14); // 2 pedidos + 12 leads puxados
    expect(feed.items.some((i) => i.action === 'pediu_leads')).toBe(true);
    expect(feed.items.some((i) => i.action === 'pegou' && i.lead?.company.startsWith('Empresa'))).toBe(true);

    const all: Page<ActivityItem> = (await admin.get('/api/activity/feed?pageSize=200')).json();
    expect(all.items.some((i) => i.user?.id === ids.dono)).toBe(false);
    const asOwner: Page<ActivityItem> = (await dono.get('/api/activity/feed?pageSize=200')).json();
    expect(asOwner.items.some((i) => i.user?.id === ids.dono)).toBe(true);
    const oldAudit = (await admin.get('/api/audit?pageSize=200')).json();
    expect(oldAudit.items.some((i: { user: { id: string } | null }) => i.user?.id === ids.dono)).toBe(false);
  });

  it('baixa a auditoria em planilha', async () => {
    const r = await admin.get(`/api/activity/feed.csv?userId=${ids.ana}`);
    expect(r.statusCode).toBe(200);
    expect(r.body.startsWith('﻿Quando;Quem;Ação;Empresa;Sócio;Detalhes;IP')).toBe(true);
    expect(r.body).toContain('Pediu leads da fila');
    expect(r.body).toContain('Cliente não é correntista');
    const logged = await sql<{
      n: number;
    }>`SELECT count(*) AS n FROM audit_log WHERE action = 'exportou_auditoria'`.execute(t.db);
    expect(logged.rows[0]?.n).toBe(1);
  });
});
