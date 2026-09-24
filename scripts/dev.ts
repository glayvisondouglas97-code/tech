/**
 * Ambiente de desenvolvimento com um comando: `npm run dev`.
 * - Sem DATABASE_URL no .env, sobe um Postgres local em .data/pg (sem Docker).
 * - Aplica as migrações.
 * - Roda o servidor (porta 3000, recarrega ao salvar) e a interface (http://localhost:5173).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDb, createPool } from '../src/server/db';
import { migrateToLatest } from '../src/server/db/migrate';
import { ensureLocalDatabase } from './local-postgres';

if (existsSync('.env')) process.loadEnvFile('.env');

let stopDb = async () => {};
if (!process.env.DATABASE_URL) {
  const local = await ensureLocalDatabase();
  process.env.DATABASE_URL = local.url;
  stopDb = local.stop;
}

const db = createDb(createPool(process.env.DATABASE_URL as string, 1));
const applied = await migrateToLatest(db);
if (applied.length) console.log(`[banco] migrações aplicadas: ${applied.join(', ')}`);
const users = await db.selectFrom('users').select('id').limit(1).executeTakeFirst();
await db.destroy();

// Banco vazio: gera um código de primeiro acesso (se não houver um no .env) para criar o dono pela tela.
const setupToken = process.env.SETUP_TOKEN || (users ? '' : randomBytes(9).toString('base64url'));
const env = {
  ...process.env,
  SETUP_TOKEN: setupToken,
  NODE_ENV: 'development',
  MIGRATE_ON_START: 'false',
  APP_URL: process.env.APP_URL || 'http://localhost:5173',
};
const node = process.execPath;
const children: ChildProcess[] = [
  // A API fica sempre na 3000 (o Vite repassa /api para ela), mesmo que PORT venha definido.
  spawn(
    node,
    [resolve('node_modules/tsx/dist/cli.mjs'), 'watch', '--clear-screen=false', 'src/server/index.ts'],
    {
      stdio: 'inherit',
      env: { ...env, PORT: '3000', HOST: '127.0.0.1' },
    },
  ),
  spawn(node, [resolve('node_modules/vite/bin/vite.js')], { stdio: 'inherit', env }),
];

if (!users) {
  console.log('\n  Sistema novo, sem usuários. Abra http://localhost:5173 e crie a conta do dono.');
  console.log(`  Código de primeiro acesso: ${setupToken}\n`);
}
console.log('  Interface: http://localhost:5173\n');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  await stopDb().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
for (const c of children) c.on('exit', () => void stop());
