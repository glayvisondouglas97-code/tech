import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { badRequest } from '../../lib/errors';
import { FileReadError, readTable, type Table } from './read-file';

// No build empacotado, o worker fica ao lado do index.js. Em desenvolvimento/testes ele não existe.
const workerPath = fileURLToPath(new URL('./parse-worker.js', import.meta.url));
const hasWorker = existsSync(workerPath);

function inThread(data: Uint8Array, fileName: string, sheet: string | null): Promise<Table> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: { data, fileName, sheet },
      resourceLimits: { maxOldGenerationSizeMb: 1536 },
    });
    worker.once('message', (msg: { ok: boolean; table?: Table; userError?: boolean; message?: string }) => {
      if (msg.ok && msg.table) resolve(msg.table);
      else reject(msg.userError ? new FileReadError(msg.message) : new Error(msg.message));
      void worker.terminate();
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Leitura do arquivo terminou com código ${code}.`));
    });
  });
}

/** Lê a planilha fora da thread principal quando possível. Erros de leitura viram mensagem para o usuário. */
export async function readTableAsync(
  data: Uint8Array,
  fileName: string,
  sheet: string | null,
): Promise<Table> {
  try {
    return hasWorker ? await inThread(data, fileName, sheet) : readTable(data, fileName, sheet);
  } catch (err) {
    if (err instanceof FileReadError) throw badRequest(err.message);
    throw badRequest('Não consegui ler esse arquivo. Confira se é uma planilha Excel ou CSV.');
  }
}

/** Cache curto das planilhas lidas, para a prévia não reler o arquivo a cada ajuste. */
const cache = new Map<string, { table: Table; at: number }>();
const CACHE_TTL = 15 * 60_000;
const CACHE_MAX = 4;

export function cachedTable(key: string): Table | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return hit.table;
}

export function cacheTable(key: string, table: Table): void {
  cache.delete(key);
  cache.set(key, { table, at: Date.now() });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function forgetTables(importId: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${importId}:`)) cache.delete(k);
}
