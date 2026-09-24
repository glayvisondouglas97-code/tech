import { type Kysely, sql } from 'kysely';

/**
 * Mensagens apagadas pelo sistema (para mim, para todos ou junto com a conversa). Guarda só o ID do
 * WhatsApp: assim a importação de histórico e os webhooks repetidos não trazem a mensagem de volta.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE wa_deleted_messages (
      instance_id int NOT NULL REFERENCES wa_instances(id) ON DELETE CASCADE,
      wa_id text NOT NULL,
      deleted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (instance_id, wa_id)
    )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS wa_deleted_messages`.execute(db);
}
