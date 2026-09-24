import { type Kysely, sql } from 'kysely';

/**
 * WhatsApp pela Evolution API (vindo da Central de WhatsApp):
 * números conectados, contatos, conversas e mensagens. As mídias ficam em arquivos, não no banco.
 * Sai a tabela do webhook da API oficial da Meta (a Evolution substitui essa integração).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS whatsapp_webhook_events`.execute(db);

  // Um número de WhatsApp (= uma instância na Evolution).
  await sql`
    CREATE TABLE wa_instances (
      id serial PRIMARY KEY,
      name text NOT NULL UNIQUE,
      nickname text CHECK (length(nickname) <= 60),
      phone_jid text,
      status text NOT NULL DEFAULT 'close',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);

  // Um contato do WhatsApp. Guarda o telefone e o @lid, para a mesma pessoa não virar dois contatos.
  await sql`
    CREATE TABLE wa_contacts (
      id serial PRIMARY KEY,
      phone_jid text UNIQUE,
      lid_jid text UNIQUE,
      name text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);

  // A conversa de um contato com um dos nossos números.
  await sql`
    CREATE TABLE wa_conversations (
      id serial PRIMARY KEY,
      instance_id int NOT NULL REFERENCES wa_instances(id),
      contact_id int NOT NULL REFERENCES wa_contacts(id),
      unread_count int NOT NULL DEFAULT 0,
      lead_replied boolean NOT NULL DEFAULT false,
      last_message_at timestamptz NOT NULL,
      last_message_preview text,
      last_message_from_me boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (instance_id, contact_id)
    )`.execute(db);
  await sql`CREATE INDEX wa_conversations_recent_idx ON wa_conversations (last_message_at DESC, id DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX wa_conversations_replied_idx ON wa_conversations (lead_replied, last_message_at DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX wa_conversations_instance_idx ON wa_conversations (instance_id, last_message_at DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX wa_conversations_unread_idx ON wa_conversations (id) WHERE unread_count > 0`.execute(
    db,
  );

  await sql`
    CREATE TABLE wa_messages (
      id serial PRIMARY KEY,
      instance_id int NOT NULL REFERENCES wa_instances(id),
      conversation_id int NOT NULL REFERENCES wa_conversations(id),
      wa_id text NOT NULL,
      remote_jid text NOT NULL,
      from_me boolean NOT NULL,
      type text NOT NULL,
      text text,
      file_name text,
      media_mime text,
      media_path text,
      status text,
      sent_at timestamptz NOT NULL,
      sent_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (instance_id, wa_id)
    )`.execute(db);
  await sql`CREATE INDEX wa_messages_conversation_idx ON wa_messages (conversation_id, sent_at DESC, id DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX wa_contacts_name_trgm_idx ON wa_contacts USING gin (name gin_trgm_ops)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS wa_messages, wa_conversations, wa_contacts, wa_instances`.execute(db);
}
