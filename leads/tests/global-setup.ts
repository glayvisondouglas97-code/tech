import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { startLocalPostgres } from '../scripts/local-postgres';
import { createDb, createPool } from '../src/server/db';
import { migrateToLatest } from '../src/server/db/migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    dbServerUrl: string;
  }
}

export const TEMPLATE_DB = 'chamador_template';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('sem porta')),
      );
    });
  });
}

export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/**
 * Sobe um Postgres descartável (ou usa TEST_DATABASE_URL, como na CI), cria um banco-modelo
 * já migrado; cada arquivo de teste copia esse modelo para um banco próprio.
 */
export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  let stop = async () => {};
  let dir: string | null = null;
  if (!url) {
    dir = mkdtempSync(join(tmpdir(), 'chamador-test-'));
    const local = await startLocalPostgres({
      dataDir: join(dir, 'data'),
      port: await freePort(),
      quiet: true,
      disposable: true,
    });
    url = local.url;
    stop = local.stop;
  }
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.end();
  const db = createDb(createPool(withDatabase(url, TEMPLATE_DB), 1));
  await migrateToLatest(db);
  await db.destroy();

  project.provide('dbServerUrl', url);
  return async () => {
    await stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
}
