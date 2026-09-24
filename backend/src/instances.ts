// Mantém a tabela de números em dia com a Evolution e configura webhook e opções de cada número.
import { prisma } from './db.ts';
import { evolution } from './evolution.ts';
import { scheduleHistoryImport } from './history.ts';
import { upsertInstance } from './store.ts';

const configured = new Set<string>();

// Aplica webhook e opções no número (idempotente).
export async function configureInstance(name: string): Promise<void> {
  await evolution.setWebhook(name);
  await evolution.setSettings(name);
  configured.add(name);
}

// Próximo nome técnico livre: whatsapp-01, whatsapp-02...
export async function nextInstanceName(): Promise<string> {
  const names = [
    ...(await prisma.instance.findMany({ select: { name: true } })).map((i) => i.name),
    ...(await evolution.fetchInstances()).map((i) => i.name),
  ];
  const numbers = names.map((n) => Number(n.match(/^whatsapp-(\d+)$/i)?.[1] ?? 0));
  return `whatsapp-${String(Math.max(0, ...numbers) + 1).padStart(2, '0')}`;
}

async function syncInstances(): Promise<void> {
  const list = await evolution.fetchInstances();
  for (const item of list) {
    const known = await prisma.instance.findUnique({ where: { name: item.name } });
    await upsertInstance(item.name, { status: item.connectionStatus, phoneJid: item.ownerJid });
    if (!configured.has(item.name)) {
      await configureInstance(item.name);
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
