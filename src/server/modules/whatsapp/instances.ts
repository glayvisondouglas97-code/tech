/** Mantém a tabela de números em dia com a Evolution e configura webhook e opções de cada número. */
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema';
import { evolution } from './evolution';
import { scheduleHistoryImport } from './history';
import { upsertInstance } from './store';

const configured = new Set<string>();

/**
 * Números excluídos agora há pouco. A Evolution ainda pode mandar avisos atrasados deles (desconexão,
 * status): esses avisos são ignorados para o número não reaparecer, e o nome não é reaproveitado logo.
 */
const recentlyDeleted = new Map<string, number>();
const DELETED_MEMORY_MS = 15 * 60_000;

export function markInstanceDeleted(name: string): void {
  recentlyDeleted.set(name, Date.now() + DELETED_MEMORY_MS);
  configured.delete(name);
}

/** A exclusão falhou (a Evolution recusou): o número volta a ser tratado normalmente. */
export function unmarkInstanceDeleted(name: string): void {
  recentlyDeleted.delete(name);
}

export function isRecentlyDeleted(name: string): boolean {
  const until = recentlyDeleted.get(name);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  recentlyDeleted.delete(name);
  return false;
}

/** Aplica webhook e opções no número (idempotente). */
export async function configureInstance(name: string): Promise<void> {
  await evolution.setWebhook(name);
  await evolution.setSettings(name);
  configured.add(name);
}

/** Próximo nome técnico livre: whatsapp-01, whatsapp-02... */
export async function nextInstanceName(db: Kysely<Database>): Promise<string> {
  const names = [
    ...(await db.selectFrom('wa_instances').select('name').execute()).map((i) => i.name),
    ...(await evolution.fetchInstances()).map((i) => i.name),
    ...[...recentlyDeleted.keys()].filter(isRecentlyDeleted),
  ];
  const numbers = names.map((n) => Number(n.match(/^whatsapp-(\d+)$/i)?.[1] ?? 0));
  return `whatsapp-${String(Math.max(0, ...numbers) + 1).padStart(2, '0')}`;
}

async function syncInstances(db: Kysely<Database>): Promise<void> {
  const list = await evolution.fetchInstances();
  for (const item of list) {
    if (isRecentlyDeleted(item.name)) continue;
    const known = await db
      .selectFrom('wa_instances')
      .select('id')
      .where('name', '=', item.name)
      .executeTakeFirst();
    await upsertInstance(db, item.name, { status: item.connectionStatus, phoneJid: item.ownerJid });
    if (!configured.has(item.name)) {
      await configureInstance(item.name);
      console.log(
        `[números] ${item.name}: webhook e configurações aplicados (status: ${item.connectionStatus})`,
      );
    }
    // Número visto pela primeira vez: traz o histórico recente.
    if (!known) scheduleHistoryImport(db, item.name, 0);
  }
}

/** Sincroniza ao iniciar (tentando até a Evolution responder) e depois a cada 5 minutos. */
export function startInstanceSync(db: Kysely<Database>): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const run = async () => {
    let nextRunMs = 5 * 60_000;
    try {
      await syncInstances(db);
    } catch (error) {
      console.error('[números] Evolution indisponível, tentando de novo em 5s:', (error as Error).message);
      nextRunMs = 5_000;
    }
    if (!stopped) timer = setTimeout(run, nextRunMs);
  };
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
