/**
 * Servidor dos testes de ponta a ponta: o mesmo build de produção (dist/), num banco novo.
 * 1. Postgres: TEST_DATABASE_URL (CI) ou o Postgres local de testes (tests/.tmp/e2e-pg).
 * 2. npm run build (interface + servidor).
 * 3. Cria a gestora com o comando de produção criar-admin.
 * 4. Sobe uma Evolution de mentira (tests/fake-evolution.ts) para o WhatsApp do sistema.
 * 5. Sobe dist/server/index.js na porta 4310.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { startLocalPostgres } from '../../scripts/local-postgres';
import { startFakeEvolution } from '../fake-evolution';

export const E2E_ADMIN = { name: 'Gestora E2E', email: 'gestora@e2e.teste', password: 'senha-e2e-123' };
/** Mesmo valor em fluxo-principal.spec.ts, que simula os webhooks da Evolution. */
const E2E_WEBHOOK_TOKEN = 'token-do-webhook-e2e';
const PORT = 4310;
const DB = 'chamador_e2e';

let stopPg = async () => {};
let base = process.env.TEST_DATABASE_URL;
if (!base) {
  const local = await startLocalPostgres({
    dataDir: resolve('tests/.tmp/e2e-pg'),
    port: 54330,
    quiet: true,
    disposable: true,
  });
  base = local.url;
  stopPg = local.stop;
}
const admin = new pg.Client({ connectionString: base });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();
const u = new URL(base);
u.pathname = `/${DB}`;
const databaseUrl = u.toString();

const node = process.execPath;
const npmCli = process.env.npm_execpath;
console.log('[e2e] compilando...');
if (npmCli) execFileSync(node, [npmCli, 'run', 'build'], { stdio: 'inherit' });
else
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    stdio: 'inherit',
    shell: true,
  });

const evolution = await startFakeEvolution();
const mediaDir = resolve('tests/.tmp/e2e-media');
rmSync(mediaDir, { recursive: true, force: true });
mkdirSync(mediaDir, { recursive: true });

const env = {
  ...process.env,
  NODE_ENV: 'production',
  DATABASE_URL: databaseUrl,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  APP_URL: `http://127.0.0.1:${PORT}`,
  JOBS_ENABLED: 'false',
  LOG_LEVEL: 'warn',
  EVOLUTION_URL: evolution.url,
  EVOLUTION_API_KEY: 'chave-e2e',
  WEBHOOK_URL: `http://127.0.0.1:${PORT}/webhook/evolution`,
  WEBHOOK_TOKEN: E2E_WEBHOOK_TOKEN,
  MEDIA_DIR: mediaDir,
};
execFileSync(
  node,
  [
    'dist/server/criar-admin.js',
    '--nome',
    E2E_ADMIN.name,
    '--email',
    E2E_ADMIN.email,
    '--senha',
    E2E_ADMIN.password,
  ],
  { stdio: 'inherit', env },
);

const server = spawn(node, ['dist/server/index.js'], { stdio: 'inherit', env });
async function shutdown() {
  server.kill();
  await evolution.close().catch(() => {});
  await stopPg().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
server.on('exit', (code) => {
  if (code) console.error(`[e2e] servidor saiu com código ${code}`);
  void stopPg().finally(() => process.exit(code ?? 0));
});
