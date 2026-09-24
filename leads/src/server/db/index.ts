import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema';

// bigint (int8) vira number: ids e contagens cabem com folga em 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric vira number (usado em médias e percentuais).
pg.types.setTypeParser(1700, (v) => Number(v));

export type Db = Kysely<Database>;

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
  pool.on('error', (err) => {
    console.error('Erro inesperado numa conexão ociosa do Postgres:', err.message);
  });
  return pool;
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
