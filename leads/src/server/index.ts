import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, createPool } from './db';
import { migrateToLatest } from './db/migrate';
import { startJobs } from './jobs/scheduler';
import { recoverStaleImports } from './modules/imports/service';

process.env.TZ = 'America/Sao_Paulo';
if (existsSync('.env')) process.loadEnvFile('.env');

/** No build de produção (dist/server/index.js) a interface fica em dist/web. */
function defaultWebDist(): string | undefined {
  if (!import.meta.url.endsWith('.js')) return undefined;
  return fileURLToPath(new URL('../web', import.meta.url));
}

async function main() {
  const config = loadConfig({ ...process.env, WEB_DIST: process.env.WEB_DIST || defaultWebDist() });
  const pool = createPool(config.DATABASE_URL);
  const db = createDb(pool);

  if (config.MIGRATE_ON_START) {
    const applied = await migrateToLatest(db);
    if (applied.length) console.log(`Banco atualizado: ${applied.join(', ')}`);
  }
  await recoverStaleImports(db);

  const app = await buildApp(db, config);
  const stopJobs = config.JOBS_ENABLED ? startJobs(db, app.log) : () => {};

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} recebido, encerrando...`);
    stopJobs();
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
