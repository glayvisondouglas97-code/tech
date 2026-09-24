/**
 * Dados de demonstração. Todos os telefones usam o DDD 00, que não existe:
 * nenhum número é real e o WhatsApp nunca vai abrir conversa com alguém de verdade.
 *
 *   npm run seed
 *
 * Só roda com o banco vazio (sem usuários) e fora de produção.
 */
import { type Kysely, sql } from 'kysely';
import { normalizeText } from '../../shared/text';
import { hashPassword } from '../auth/password';
import { createDb, createPool } from '../db';
import { migrateToLatest } from '../db/migrate';
import type { Database } from '../db/schema';
import { scriptDatabase } from './script-db';

export const DEMO_PASSWORD = 'demonstracao';

const FIRST = [
  'Mariana',
  'João',
  'Aline',
  'Carlos',
  'Patrícia',
  'Rafael',
  'Juliana',
  'Bruno',
  'Fernanda',
  'Lucas',
  'Camila',
  'Diego',
  'Larissa',
  'Thiago',
  'Beatriz',
  'Gustavo',
  'Renata',
  'Felipe',
  'Sabrina',
  'Eduardo',
];
const LAST = [
  'Souza',
  'Pereira',
  'Martins',
  'Lima',
  'Gomes',
  'Nunes',
  'Rocha',
  'Almeida',
  'Costa',
  'Ribeiro',
  'Carvalho',
  'Teixeira',
  'Barbosa',
  'Moreira',
  'Cardoso',
];
const CITIES = [
  'Curitiba',
  'São Paulo',
  'Londrina',
  'Campinas',
  'Joinville',
  'Maringá',
  'Santos',
  'Blumenau',
];
const INTEREST = ['Conta PJ', 'Maquininha', 'Capital de giro', 'Antecipação', 'Informações'];
const BUSINESS = [
  'Padaria',
  'Mercado',
  'Oficina',
  'Clínica',
  'Auto Peças',
  'Restaurante',
  'Distribuidora',
  'Farmácia',
  'Construtora',
  'Academia',
];
const SUFFIX = ['Ltda', 'ME', 'EIRELI', 'Comércio Ltda'];

/** DDDs que não existem no Brasil: nenhum número da demonstração é real. */
export const FAKE_DDDS = ['20', '23', '25', '29'];

/** Telefone fictício: +55 (20|23|25|29) 9xxxx-xxxx. */
export function fakePhone(n: number): string {
  return `55${FAKE_DDDS[n % FAKE_DDDS.length]}9${String(10_000_000 + n).slice(-8)}`;
}

export async function seedDemo(
  db: Kysely<Database>,
): Promise<{ users: { name: string; email: string; role: string }[] }> {
  const hash = await hashPassword(DEMO_PASSWORD);
  const people = [
    { name: 'Dono Demonstração', email: 'dono@exemplo.com.br', role: 'dono' as const },
    { name: 'Gestora Demonstração', email: 'gestora@exemplo.com.br', role: 'admin' as const },
    { name: 'Sérgio Supervisor', email: 'supervisor@exemplo.com.br', role: 'supervisor' as const },
    { name: 'Ana Atendente', email: 'ana@exemplo.com.br', role: 'atendente' as const },
    { name: 'Bruno Atendente', email: 'bruno@exemplo.com.br', role: 'atendente' as const },
    { name: 'Carla Atendente', email: 'carla@exemplo.com.br', role: 'atendente' as const },
  ];
  const users = await db
    .insertInto('users')
    .values(people.map((p) => ({ ...p, password_hash: hash, password_changed_at: new Date() })))
    .returning(['id', 'name', 'email', 'role'])
    .execute();
  const [, admin, , ana, bruno, carla] = users as [
    (typeof users)[number],
    (typeof users)[number],
    (typeof users)[number],
    (typeof users)[number],
    (typeof users)[number],
    (typeof users)[number],
  ];

  const DAY = 86_400_000;
  const now = Date.now();
  let phoneSeq = 1;

  async function makeList(name: string, count: number, daysAgo: number) {
    const list = await db
      .insertInto('lists')
      .values({
        name,
        created_by: admin.id,
        created_at: new Date(now - daysAgo * DAY),
        extra_columns: ['Cidade', 'Interesse'],
        total: count,
        distribution: 'fila',
        source_file: 'exemplo.xlsx',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const rows = Array.from({ length: count }, (_, i) => {
      const last = LAST[(i * 3 + phoneSeq) % LAST.length] as string;
      const nm = `${FIRST[(i * 7 + phoneSeq) % FIRST.length]} ${last}`;
      const company = `${BUSINESS[(i + phoneSeq) % BUSINESS.length]} ${last} ${SUFFIX[i % SUFFIX.length]} (fictícia)`;
      return {
        list_id: list.id,
        row_number: i + 2,
        name: nm,
        name_search: normalizeText(nm),
        company,
        company_search: normalizeText(company),
        phone: fakePhone(phoneSeq++),
        phone_type: 'movel' as const,
        extra: JSON.stringify({
          Cidade: CITIES[i % CITIES.length] as string,
          Interesse: INTEREST[i % INTEREST.length] as string,
        }),
        created_at: new Date(now - daysAgo * DAY),
      };
    });
    const ids = await db.insertInto('leads').values(rows).returning('id').execute();
    await sql`INSERT INTO lead_events (lead_id, user_id, type, data, created_at)
      SELECT id, ${admin.id}::uuid, 'importado', jsonb_build_object('lista', ${name}::text), created_at
      FROM leads WHERE list_id = ${list.id}::uuid`.execute(db);
    return ids.map((r) => r.id);
  }

  const campaign = await makeList('Exemplo: campanha de setembro (fictícia)', 120, 12);
  await makeList('Exemplo: indicações (fictícia)', 40, 2);

  const results = [
    'enviado',
    'respondeu',
    'interessado',
    'fechou',
    'sem_conta',
    'nao_correntista',
    'nao_respondeu',
    'sem_interesse',
    'sem_whatsapp',
  ] as const;
  const team = [ana, bruno, carla];
  // 45 já chamados nos últimos 10 dias
  for (let i = 0; i < 45; i++) {
    const id = campaign[i] as number;
    const who = team[i % 3] as (typeof team)[number];
    const calledAt = new Date(now - (i % 10) * DAY - (i % 7) * 3_600_000 - 600_000);
    const assignedAt = new Date(calledAt.getTime() - 3_600_000);
    const result = results[i % results.length] as (typeof results)[number];
    await db
      .updateTable('leads')
      .set({
        status: 'chamado',
        assigned_to: who.id,
        assigned_at: assignedAt,
        assigned_via: 'pegou',
        whatsapp_opened_at: calledAt,
        called_by: who.id,
        called_at: calledAt,
        result,
        note: i % 9 === 2 ? 'Pediu para retornar na semana que vem.' : null,
        callback_at: i % 9 === 2 ? new Date(now + ((i % 3) - 1) * 3_600_000 * 4) : null,
      })
      .where('id', '=', id)
      .execute();
    await db
      .insertInto('lead_events')
      .values([
        { lead_id: id, user_id: who.id, type: 'pegou', created_at: assignedAt },
        { lead_id: id, user_id: who.id, type: 'abriu_whatsapp', created_at: calledAt },
        {
          lead_id: id,
          user_id: who.id,
          type: 'chamado',
          data: JSON.stringify({ resultado: result }),
          created_at: calledAt,
        },
      ])
      .execute();
  }
  // 30 na fila dos atendentes, ainda não chamados
  for (let i = 45; i < 75; i++) {
    const id = campaign[i] as number;
    const who = team[i % 2] as (typeof team)[number];
    await db
      .updateTable('leads')
      .set({ assigned_to: who.id, assigned_at: new Date(now - 2 * 3_600_000), assigned_via: 'pegou' })
      .where('id', '=', id)
      .execute();
    await db.insertInto('lead_events').values({ lead_id: id, user_id: who.id, type: 'pegou' }).execute();
  }
  // Um número na lista de não contatar
  const blockedId = campaign[80] as number;
  const blocked = await db
    .selectFrom('leads')
    .select('phone')
    .where('id', '=', blockedId)
    .executeTakeFirstOrThrow();
  await db
    .insertInto('blocked_phones')
    .values({ phone: blocked.phone, reason: 'Pediu para não ser contatado', created_by: admin.id })
    .execute();
  await db.updateTable('leads').set({ status: 'bloqueado' }).where('id', '=', blockedId).execute();
  await db
    .insertInto('lead_events')
    .values({
      lead_id: blockedId,
      user_id: admin.id,
      type: 'bloqueado',
      data: JSON.stringify({ motivo: 'Pediu para não ser contatado' }),
    })
    .execute();

  return { users: people };
}

// Execução direta: npm run seed
const isMain = process.argv[1] && /seed\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  if (process.env.NODE_ENV === 'production') {
    console.error('Os dados de demonstração não podem ser criados em produção.');
    process.exit(1);
  }
  const target = await scriptDatabase();
  // --recriar: apaga tudo e recria a demonstração. Só em banco local (localhost), nunca em produção.
  if (process.argv.includes('--recriar')) {
    const host = new URL(target.url).hostname;
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
      console.error(`--recriar só funciona com banco local. Este banco está em "${host}".`);
      await target.done();
      process.exit(1);
    }
    const wipe = createDb(createPool(target.url, 1));
    await sql`DROP SCHEMA public CASCADE; CREATE SCHEMA public`.execute(wipe);
    await wipe.destroy();
    console.log('Banco local apagado.');
  }
  const db = createDb(createPool(target.url, 2));
  try {
    await migrateToLatest(db);
    const any = await db.selectFrom('users').select('id').limit(1).executeTakeFirst();
    if (any) {
      console.error('O banco já tem usuários. A demonstração só é criada num banco vazio.');
      process.exitCode = 1;
    } else {
      const { users } = await seedDemo(db);
      console.log(
        `\nDados de demonstração criados (empresas fictícias, telefones com DDDs que não existem: ${FAKE_DDDS.join(', ')}).`,
      );
      console.log(`Senha de todos: ${DEMO_PASSWORD}\n`);
      for (const u of users) console.log(`  ${u.role.padEnd(10)} ${u.email}`);
      console.log('');
    }
  } finally {
    await db.destroy();
    await target.done();
  }
}
