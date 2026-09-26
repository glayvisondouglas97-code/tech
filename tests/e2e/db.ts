import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { up as backfillQuota } from '../../src/server/db/migrations/0015_backfill_cota_diaria';

/**
 * Acesso direto ao banco dos testes de ponta a ponta, só para PREPARAR cenários que não dá para montar pela tela
 * (por exemplo, um número que já fez 20 contatos hoje, sem mandar 20 mensagens de verdade pelo navegador).
 * O banco é o mesmo de tests/e2e/server.ts: TEST_DATABASE_URL (CI) ou o Postgres local de testes.
 */
const BASE = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:54330/postgres';

function e2eDatabaseUrl(): string {
  const url = new URL(BASE);
  url.pathname = '/chamador_e2e';
  return url.toString();
}

/** Grava o uso de HOJE (dia de São Paulo) de um número: manuais e automáticos já feitos. */
export async function seedTodayUsage(
  instanceName: string,
  counts: { manual: number; automatic: number },
): Promise<void> {
  const client = new pg.Client({ connectionString: e2eDatabaseUrl() });
  await client.connect();
  try {
    const total = counts.manual + counts.automatic;
    const result = await client.query(
      `INSERT INTO wa_instance_daily_usage (instance_id, usage_date, manual_contacts, automatic_contacts, total_contacts)
       SELECT id, (now() AT TIME ZONE 'America/Sao_Paulo')::date, $2::int, $3::int, $4::int FROM wa_instances WHERE name = $1
       ON CONFLICT (instance_id, usage_date) DO UPDATE
         SET manual_contacts = EXCLUDED.manual_contacts, automatic_contacts = EXCLUDED.automatic_contacts,
             uncertain_contacts = 0, total_contacts = EXCLUDED.total_contacts`,
      [instanceName, counts.manual, counts.automatic, total],
    );
    if (result.rowCount !== 1) throw new Error(`Número ${instanceName} não encontrado no banco de teste.`);
  } finally {
    await client.end();
  }
}

/**
 * Apaga a cota de HOJE (o estado "antes da migração da cota", em que a tabela ainda estava vazia): de um número, ou de todos
 * se nenhum nome for dado.
 */
export async function clearTodayUsage(instanceName?: string): Promise<void> {
  const client = new pg.Client({ connectionString: e2eDatabaseUrl() });
  await client.connect();
  try {
    await client.query(
      `DELETE FROM wa_instance_daily_usage
       WHERE usage_date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
         AND ($1::text IS NULL OR instance_id = (SELECT id FROM wa_instances WHERE name = $1))`,
      [instanceName ?? null],
    );
  } finally {
    await client.end();
  }
}

/** Roda o backfill da cota (a mesma migração `0015` que o sistema roda ao atualizar) sobre o banco do teste. */
export async function runQuotaBackfill(): Promise<void> {
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: e2eDatabaseUrl() }) }),
  });
  try {
    await backfillQuota(db);
  } finally {
    await db.destroy();
  }
}
