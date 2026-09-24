import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../../src/server/auth/sessions';
import { pullLeads } from '../../src/server/modules/leads/service';
import { type Client, createTestApp, createUser, loginAs, seedList, type TestApp } from '../helpers';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
  await t.db.updateTable('settings').set({ pull_size: 7 }).execute();
});
afterAll(async () => t.close());

describe('"Pegar próximos leads" é atômico', () => {
  it('dois atendentes clicando ao mesmo tempo nunca recebem o mesmo lead (HTTP)', async () => {
    await seedList(t.db, { count: 300, phoneStart: 0 });
    const a = await loginAs(t.app, await createUser(t.db, { name: 'Ana', role: 'atendente' }));
    const b = await loginAs(t.app, await createUser(t.db, { name: 'Bruno', role: 'atendente' }));
    const seen = new Map<number, string>();
    for (let round = 0; round < 25; round++) {
      const [ra, rb] = await Promise.all([a.post('/api/queue/pull'), b.post('/api/queue/pull')]);
      for (const [who, r] of [
        ['ana', ra],
        ['bruno', rb],
      ] as const) {
        expect(r.statusCode).toBe(200);
        for (const lead of r.json().leads as { id: number; assignedTo: { name: string } }[]) {
          expect(seen.has(lead.id), `lead ${lead.id} entregue duas vezes`).toBe(false);
          seen.set(lead.id, who);
        }
      }
    }
    expect(seen.size).toBe(300);
    const pegou = await t.db
      .selectFrom('lead_events')
      .select('lead_id')
      .where('type', '=', 'pegou')
      .execute();
    expect(pegou).toHaveLength(300);
    expect(new Set(pegou.map((e) => e.lead_id)).size).toBe(300);
  });

  it('30 atendentes em paralelo, com várias conexões ao banco: nenhum lead duplicado', async () => {
    const { leadIds } = await seedList(t.db, { count: 1000, phoneStart: 10_000 });
    const people: AuthUser[] = [];
    for (let i = 0; i < 30; i++) {
      const u = await createUser(t.db, { name: `Atendente ${i}`, role: 'atendente' });
      people.push({ id: u.id, name: u.name, email: u.email, role: 'atendente' });
    }
    const got: number[] = [];
    for (let round = 0; round < 6; round++) {
      const results = await Promise.all(people.map((p) => pullLeads(t.db, p)));
      for (const r of results) got.push(...r.leads.map((l) => l.id));
    }
    const fromThisList = got.filter((id) => leadIds.includes(id));
    expect(new Set(fromThisList).size).toBe(fromThisList.length);
    expect(fromThisList.length).toBe(1000);
    const rows = await t.db
      .selectFrom('leads')
      .select(['id', 'assigned_to'])
      .where('id', 'in', leadIds)
      .execute();
    expect(rows.every((r) => r.assigned_to)).toBe(true);
  });

  it('respeita o limite de leads na fila e o clique duplo do mesmo atendente', async () => {
    await t.db.updateTable('settings').set({ pull_size: 10, max_queue: 15 }).execute();
    await seedList(t.db, { count: 100, phoneStart: 50_000 });
    const c: Client = await loginAs(t.app, await createUser(t.db, { name: 'Carla', role: 'atendente' }));
    const [r1, r2] = await Promise.all([c.post('/api/queue/pull'), c.post('/api/queue/pull')]);
    expect(r1.json().count + r2.json().count).toBe(15);
    const r3 = await c.post('/api/queue/pull');
    expect(r3.statusCode).toBe(409);
    expect(r3.json().error).toMatch(/limite é 15/);
    await t.db.updateTable('settings').set({ max_queue: 0 }).execute();
  });

  it('não entrega leads de listas arquivadas', async () => {
    const { listId } = await seedList(t.db, { count: 5, phoneStart: 90_000 });
    await t.db
      .updateTable('leads')
      .set({ assigned_to: null })
      .where('status', '=', 'pendente')
      .where('list_id', '<>', listId)
      .execute();
    await t.db
      .updateTable('leads')
      .set({ status: 'chamado', called_at: new Date(), result: 'enviado' })
      .where('list_id', '<>', listId)
      .execute();
    await t.db.updateTable('lists').set({ archived_at: new Date() }).where('id', '=', listId).execute();
    const c = await loginAs(t.app, await createUser(t.db, { name: 'Davi', role: 'atendente' }));
    expect((await c.post('/api/queue/pull')).json().count).toBe(0);
  });
});
