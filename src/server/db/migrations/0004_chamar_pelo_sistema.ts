import { type Kysely, sql } from 'kysely';

/**
 * Botão "Chamar" pelo próprio sistema (Fase 9):
 * - a conversa de WhatsApp guarda o lead que foi chamado por ela (marcação automática do resultado);
 * - a conversa pode existir antes da primeira mensagem (aberta pelo "Chamar", ainda sem nada enviado);
 * - saem as mensagens prontas: o primeiro contato agora é feito pelo chat (áudio gravado na hora).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE wa_conversations ADD COLUMN lead_id int REFERENCES leads(id) ON DELETE SET NULL`.execute(
    db,
  );
  await sql`CREATE INDEX wa_conversations_lead_idx ON wa_conversations (lead_id) WHERE lead_id IS NOT NULL`.execute(
    db,
  );
  await sql`ALTER TABLE wa_conversations ALTER COLUMN last_message_at DROP NOT NULL`.execute(db);
  await sql`DROP TABLE IF EXISTS message_templates`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM wa_conversations WHERE last_message_at IS NULL`.execute(db);
  await sql`ALTER TABLE wa_conversations ALTER COLUMN last_message_at SET NOT NULL`.execute(db);
  await sql`ALTER TABLE wa_conversations DROP COLUMN IF EXISTS lead_id`.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS message_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
      body text NOT NULL CHECK (length(body) <= 2000),
      is_default boolean NOT NULL DEFAULT false,
      sort int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS message_templates_one_default ON message_templates (is_default) WHERE is_default`.execute(
    db,
  );
}
