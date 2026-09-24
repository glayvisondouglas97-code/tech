/**
 * Thread separada para ler planilhas grandes sem travar o servidor.
 * Só roda no build de produção (dist/server/parse-worker.js); no desenvolvimento a leitura é direta.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { FileReadError, readTable } from './read-file';

const { data, fileName, sheet } = workerData as { data: Uint8Array; fileName: string; sheet: string | null };
try {
  parentPort?.postMessage({ ok: true, table: readTable(data, fileName, sheet) });
} catch (err) {
  parentPort?.postMessage({
    ok: false,
    userError: err instanceof FileReadError,
    message: err instanceof Error ? err.message : String(err),
  });
}
