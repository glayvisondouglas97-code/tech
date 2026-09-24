import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, createTestApp, createUser, loginAs, type TestApp } from '../helpers';

/**
 * Escala: 100 mil leads (30 mil já chamados). As telas usam paginação e filtros no servidor,
 * então cada resposta precisa continuar rápida e pequena. Limites folgados para não falhar à toa
 * numa máquina lenta; na prática ficam bem abaixo.
 */
let t: TestApp;
let admin: Client;
let ana: Client;
let anaId: string;

const TOTAL = 100_000;

beforeAll(async () => {
  t = await createTestApp();
  const g = await createUser(t.db, { name: 'Gestora', role: 'admin' });
  const a = await createUser(t.db, { name: 'Ana', role: 'atendente' });
  const b = await createUser(t.db, { name: 'Bruno', role: 'atendente' });
  anaId = a.id;
  admin = await loginAs(t.app, g);
  ana = await loginAs(t.app, a);
  const lists = await t.db
    .insertInto('lists')
    .values(
      [1, 2, 3, 4].map((i) => ({
        name: `Lista ${i}`,
        distribution: 'fila' as const,
        extra_columns: ['Cidade'],
      })),
    )
    .returning('id')
    .execute();
  const ids = lists.map((l) => l.id);
  await sql`
    INSERT INTO leads (list_id, row_number, name, name_search, phone, phone_type, extra, status,
                       assigned_to, assigned_at, called_by, called_at, result)
    SELECT (${ids}::uuid[])[1 + (g % 4)], g, 'Cliente ' || g, 'cliente ' || g,
      '55419' || lpad((70000000 + g)::text, 8, '0'), 'movel', jsonb_build_object('Cidade', 'Curitiba'),
      CASE WHEN g % 10 < 3 THEN 'chamado' ELSE 'pendente' END,
      CASE WHEN g % 10 < 3 THEN (CASE WHEN g % 2 = 0 THEN ${a.id}::uuid ELSE ${b.id}::uuid END)
           WHEN g % 10 = 3 THEN ${a.id}::uuid ELSE NULL END,
      CASE WHEN g % 10 <= 3 THEN now() - interval '1 hour' ELSE NULL END,
      CASE WHEN g % 10 < 3 THEN (CASE WHEN g % 2 = 0 THEN ${a.id}::uuid ELSE ${b.id}::uuid END) ELSE NULL END,
      CASE WHEN g % 10 < 3 THEN now() - (g % 40) * interval '1 day' ELSE NULL END,
      CASE WHEN g % 10 < 3 THEN (ARRAY['enviado','respondeu','interessado','fechou','sem_interesse','sem_whatsapp'])[1 + g % 6] ELSE NULL END
    FROM generate_series(1, ${TOTAL}) AS g`.execute(t.db);
  await sql`ANALYZE leads`.execute(t.db);
}, 180_000);
afterAll(async () => t.close());

async function timed(c: Client, url: string, method: 'GET' | 'POST' = 'GET') {
  const start = performance.now();
  const r = method === 'GET' ? await c.get(url) : await c.post(url);
  const ms = performance.now() - start;
  expect(r.statusCode, `${url}: ${r.body.slice(0, 200)}`).toBe(200);
  return { ms, r };
}

describe(`escala com ${TOTAL.toLocaleString('pt-BR')} leads`, () => {
  it('fila, contadores e "pegar" continuam rápidos e não trazem a base inteira', async () => {
    const q = await timed(ana, '/api/queue');
    expect(q.r.json().items).toHaveLength(50);
    expect(q.r.json().total).toBe(10_000);
    expect(q.r.body.length).toBeLessThan(80_000);
    expect(q.ms).toBeLessThan(1500);
    expect((await timed(ana, '/api/queue/stats')).ms).toBeLessThan(1500);
    const p = await timed(ana, '/api/queue/pull', 'POST');
    expect(p.r.json().count).toBe(10);
    expect(p.ms).toBeLessThan(1500);
  });

  it('"Já chamados" pagina no servidor, com busca e filtros', async () => {
    const page = await timed(admin, '/api/leads?view=chamados&period=tudo&page=3');
    expect(page.r.json().total).toBe(30_000);
    expect(page.r.json().items).toHaveLength(50);
    expect(page.ms).toBeLessThan(2000);
    const search = await timed(admin, '/api/leads?view=chamados&period=tudo&q=cliente%2099990');
    expect(search.r.json().total).toBe(1);
    expect(search.ms).toBeLessThan(2000);
    const phone = await timed(admin, `/api/leads?view=todos&q=${encodeURIComponent('(41) 97009-9990')}`);
    expect(phone.r.json().total).toBe(1);
    const mine = await timed(ana, `/api/leads?view=chamados&period=30d&result=fechou`);
    expect(mine.r.json().items.every((l: { calledBy: { id: string } }) => l.calledBy.id === anaId)).toBe(
      true,
    );
  });

  it('painel agrega tudo no servidor', async () => {
    const d = await timed(admin, '/api/dashboard');
    expect(d.r.json().totals.leads).toBe(TOTAL);
    expect(d.ms).toBeLessThan(3000);
  });

  it('exporta a base completa em CSV sem carregar tudo de uma vez', async () => {
    const e = await timed(admin, '/api/export/leads.csv?view=todos');
    expect(e.r.body.split('\r\n').filter(Boolean)).toHaveLength(TOTAL + 1);
    expect(e.ms).toBeLessThan(30_000);
  }, 60_000);
});
