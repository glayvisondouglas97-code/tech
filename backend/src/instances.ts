// Mantém a tabela de números em dia com a Evolution e configura webhook e opções de cada número.
import { prisma } from './db.ts';
import { evolution } from './evolution.ts';
import { scheduleHistoryImport } from './history.ts';
import { upsertInstance } from './store.ts';

const configured = new Set<string>();

async function syncInstances(): Promise<void> {
  const list = await evolution.fetchInstances();
  for (const item of list) {
    const known = await prisma.instance.findUnique({ where: { name: item.name } });
    await upsertInstance(item.name, { status: item.connectionStatus, phoneJid: item.ownerJid });
    if (!configured.has(item.name)) {
      await evolution.setWebhook(item.name);
      await evolution.setSettings(item.name);
      configured.add(item.name);
      console.log(`[números] ${item.name}: webhook e configurações aplicados (status: ${item.connectionStatus})`);
    }
    // Número visto pela primeira vez: traz o histórico recente.
    if (!known) scheduleHistoryImport(item.name, 0);
  }
}

// Sincroniza ao iniciar (tentando até a Evolution responder) e depois a cada 5 minutos.
export function startInstanceSync(): void {
  const run = async () => {
    let nextRunMs = 5 * 60_000;
    try {
      await syncInstances();
    } catch (error) {
      console.error('[números] Evolution indisponível, tentando de novo em 5s:', (error as Error).message);
      nextRunMs = 5_000;
    }
    setTimeout(run, nextRunMs);
  };
  void run();
}
