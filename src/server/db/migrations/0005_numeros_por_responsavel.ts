import { type Kysely, sql } from 'kysely';

/**
 * Cada número de WhatsApp tem um responsável (quem cadastrou, ou quem o administrador escolher).
 * O atendente vê só as conversas dos números dele; dono, administrador e supervisor veem todas.
 * Números que já existiam ficam sem responsável até o administrador escolher um.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE wa_instances ADD COLUMN owner_id uuid REFERENCES users(id) ON DELETE SET NULL`.execute(
    db,
  );
  await sql`CREATE INDEX wa_instances_owner_idx ON wa_instances (owner_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE wa_instances DROP COLUMN IF EXISTS owner_id`.execute(db);
}
