import type { Kysely } from 'kysely';
import type { Database } from '../db/schema';

export interface NewEvent {
  leadId: number;
  userId: string | null;
  type: string;
  data?: Record<string, unknown>;
}

/** Histórico do lead: só acrescenta, nunca apaga nem reescreve (exceto na anonimização pela LGPD). */
export async function addEvents(db: Kysely<Database>, events: NewEvent[]): Promise<void> {
  for (let i = 0; i < events.length; i += 1000) {
    const chunk = events.slice(i, i + 1000);
    await db
      .insertInto('lead_events')
      .values(
        chunk.map((e) => ({
          lead_id: e.leadId,
          user_id: e.userId,
          type: e.type,
          data: JSON.stringify(e.data ?? {}),
        })),
      )
      .execute();
  }
}

export async function addEvent(db: Kysely<Database>, e: NewEvent): Promise<void> {
  await addEvents(db, [e]);
}
