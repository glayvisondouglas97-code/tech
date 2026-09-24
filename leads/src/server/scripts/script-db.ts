import { existsSync } from 'node:fs';

/**
 * Endereço do banco para os comandos (seed, criar-admin, migrate).
 * Usa DATABASE_URL; sem ela (no computador), usa o Postgres local do "npm run dev".
 */
export async function scriptDatabase(): Promise<{ url: string; done: () => Promise<void> }> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, done: async () => {} };
  const { ensureLocalDatabase } = await import('../../../scripts/local-postgres');
  const local = await ensureLocalDatabase({ quiet: true });
  return { url: local.url, done: local.stop };
}
