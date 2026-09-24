// Importação do histórico recente (últimos N dias) de um número.
// A Evolution guarda no próprio banco o histórico que o WhatsApp envia ao conectar. Buscamos de lá,
// o que serve tanto para números novos quanto para números que já estavam conectados.
import { config } from './config.ts';
import { evolution } from './evolution.ts';
import { enqueue } from './queue.ts';
import { publishReload } from './realtime.ts';
import { saveMessage } from './store.ts';
import { isNewerStatus } from './whatsapp.ts';

const PAGE_SIZE = 100;
const running = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();

export async function importHistory(instanceName: string): Promise<{ total: number; saved: number }> {
  if (running.has(instanceName)) throw new Error(`Importação de ${instanceName} já está em andamento`);
  running.add(instanceName);
  try {
    const until = new Date();
    const since = new Date(until.getTime() - config.historyDays * 24 * 60 * 60 * 1000);
    let page = 1;
    let pages = 1;
    let total = 0;
    let saved = 0;
    do {
      const { messages } = await evolution.findMessages(instanceName, since, until, page, PAGE_SIZE);
      pages = messages.pages;
      total = messages.total;
      saved += await enqueue(async () => {
        let count = 0;
        for (const record of messages.records) {
          // O status das enviadas vem na lista de atualizações; usa o mais avançado.
          const status = (record.MessageUpdate ?? []).reduce<string | null>(
            (best, u) => (isNewerStatus(best, u.status) ? u.status : best),
            record.status ?? null,
          );
          try {
            if (await saveMessage(instanceName, { ...record, status }, { live: false })) count++;
          } catch (error) {
            console.error(`[histórico] ${instanceName}: mensagem ${record?.key?.id} ignorada:`, error);
          }
        }
        return count;
      });
      page++;
    } while (page <= pages);
    console.log(`[histórico] ${instanceName}: ${saved} mensagens novas (de ${total} dos últimos ${config.historyDays} dias)`);
    if (saved > 0) publishReload();
    return { total, saved };
  } finally {
    running.delete(instanceName);
  }
}

// O WhatsApp manda o histórico em vários lotes ao conectar. Espera os lotes pararem de chegar e importa uma vez só.
export function scheduleHistoryImport(instanceName: string, delayMs = 20_000): void {
  clearTimeout(timers.get(instanceName));
  timers.set(
    instanceName,
    setTimeout(() => {
      timers.delete(instanceName);
      if (running.has(instanceName)) {
        scheduleHistoryImport(instanceName, delayMs);
        return;
      }
      importHistory(instanceName).catch((error) => console.error(`[histórico] ${instanceName}: falhou:`, error));
    }, delayMs),
  );
}
