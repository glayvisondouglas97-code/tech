import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);

  await sql`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
      email text NOT NULL CHECK (length(email) BETWEEN 3 AND 200),
      password_hash text,
      role text NOT NULL CHECK (role IN ('admin', 'supervisor', 'atendente')),
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_login_at timestamptz,
      password_changed_at timestamptz
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX users_email_key ON users (lower(email))`.execute(db);

  await sql`
    CREATE TABLE sessions (
      id text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      ip text,
      user_agent text
    )`.execute(db);
  await sql`CREATE INDEX sessions_user_idx ON sessions (user_id)`.execute(db);
  await sql`CREATE INDEX sessions_expires_idx ON sessions (expires_at)`.execute(db);

  await sql`
    CREATE TABLE password_tokens (
      id text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose text NOT NULL CHECK (purpose IN ('convite', 'redefinir')),
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    )`.execute(db);
  await sql`CREATE INDEX password_tokens_user_idx ON password_tokens (user_id)`.execute(db);

  await sql`
    CREATE TABLE settings (
      id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      company_name text NOT NULL DEFAULT 'Chamador de Leads',
      logo bytea,
      logo_mime text,
      logo_updated_at timestamptz,
      pull_size int NOT NULL DEFAULT 10 CHECK (pull_size BETWEEN 1 AND 200),
      max_queue int NOT NULL DEFAULT 0 CHECK (max_queue BETWEEN 0 AND 100000),
      expire_hours int NOT NULL DEFAULT 48 CHECK (expire_hours BETWEEN 0 AND 8760),
      hourly_contact_warning int NOT NULL DEFAULT 60 CHECK (hourly_contact_warning BETWEEN 0 AND 10000),
      default_ddd text CHECK (default_ddd ~ '^[1-9][0-9]$'),
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL
    )`.execute(db);
  await sql`INSERT INTO settings (id) VALUES (1)`.execute(db);

  await sql`
    CREATE TABLE message_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
      body text NOT NULL CHECK (length(body) <= 2000),
      is_default boolean NOT NULL DEFAULT false,
      sort int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX message_templates_one_default ON message_templates (is_default) WHERE is_default`.execute(
    db,
  );
  await sql`
    INSERT INTO message_templates (name, body, is_default, sort) VALUES (
      'Primeiro contato',
      'Olá, {nome}! Tudo bem? Aqui é {atendente}. Vi que você demonstrou interesse e queria te passar mais informações. Posso te ajudar?',
      true, 0
    )`.execute(db);

  await sql`
    CREATE TABLE imports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'rascunho'
        CHECK (status IN ('rascunho', 'processando', 'concluida', 'falhou', 'descartada')),
      source text NOT NULL CHECK (source IN ('arquivo', 'colado')),
      file_name text NOT NULL,
      file_sha256 text NOT NULL,
      file_size int NOT NULL,
      file_data bytea,
      options jsonb,
      summary jsonb,
      list_id uuid,
      error text,
      started_at timestamptz,
      finished_at timestamptz
    )`.execute(db);
  await sql`CREATE INDEX imports_sha_idx ON imports (file_sha256) WHERE status = 'concluida'`.execute(db);
  await sql`CREATE INDEX imports_created_idx ON imports (created_at DESC)`.execute(db);

  await sql`
    CREATE TABLE lists (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz,
      extra_columns text[] NOT NULL DEFAULT '{}',
      total int NOT NULL DEFAULT 0,
      distribution text NOT NULL CHECK (distribution IN ('fila', 'dividir', 'pessoa')),
      source_file text,
      import_id uuid REFERENCES imports(id) ON DELETE SET NULL
    )`.execute(db);
  await sql`ALTER TABLE imports ADD CONSTRAINT imports_list_fk FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE SET NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE leads (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      list_id uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      row_number int NOT NULL,
      name text NOT NULL DEFAULT '',
      name_search text NOT NULL DEFAULT '',
      phone text NOT NULL,
      phone_type text CHECK (phone_type IN ('movel', 'fixo')),
      extra_phones text[] NOT NULL DEFAULT '{}',
      extra jsonb NOT NULL DEFAULT '{}',
      status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'chamado', 'bloqueado')),
      assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
      assigned_at timestamptz,
      assigned_via text CHECK (assigned_via IN ('pegou', 'importacao', 'gestor', 'retorno')),
      whatsapp_opened_at timestamptz,
      called_by uuid REFERENCES users(id) ON DELETE SET NULL,
      called_at timestamptz,
      result text CHECK (result IN ('enviado', 'respondeu', 'interessado', 'fechou', 'sem_interesse', 'sem_whatsapp')),
      note text CHECK (length(note) <= 1000),
      callback_at timestamptz,
      anonymized_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      version int NOT NULL DEFAULT 1,
      CONSTRAINT leads_chamado_tem_dados CHECK (status <> 'chamado' OR (called_at IS NOT NULL AND result IS NOT NULL)),
      CONSTRAINT leads_chamado_tem_quem CHECK (called_at IS NULL OR result IS NOT NULL)
    )`.execute(db);

  // Fila livre, na ordem de importação (listas mais antigas primeiro).
  await sql`CREATE INDEX leads_free_idx ON leads (id) WHERE status = 'pendente' AND assigned_to IS NULL`.execute(
    db,
  );
  // Fila de cada atendente.
  await sql`CREATE INDEX leads_queue_idx ON leads (assigned_to, assigned_at, id) WHERE status = 'pendente'`.execute(
    db,
  );
  // "Já chamados" e métricas.
  await sql`CREATE INDEX leads_called_idx ON leads (called_at DESC) WHERE called_at IS NOT NULL`.execute(db);
  await sql`CREATE INDEX leads_called_by_idx ON leads (called_by, called_at DESC) WHERE called_at IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX leads_callback_idx ON leads (called_by, callback_at) WHERE callback_at IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX leads_list_idx ON leads (list_id, row_number)`.execute(db);
  await sql`CREATE INDEX leads_phone_idx ON leads (phone)`.execute(db);
  await sql`CREATE INDEX leads_name_trgm_idx ON leads USING gin (name_search gin_trgm_ops)`.execute(db);
  await sql`CREATE INDEX leads_phone_trgm_idx ON leads USING gin (phone gin_trgm_ops)`.execute(db);

  await sql`
    CREATE TABLE lead_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      lead_id bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      type text NOT NULL,
      data jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX lead_events_lead_idx ON lead_events (lead_id, id)`.execute(db);
  await sql`CREATE INDEX lead_events_user_type_idx ON lead_events (user_id, type, created_at)`.execute(db);

  await sql`
    CREATE TABLE import_rejections (
      import_id uuid NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
      row_number int NOT NULL,
      reason text NOT NULL,
      "values" text[] NOT NULL,
      PRIMARY KEY (import_id, row_number)
    )`.execute(db);

  await sql`
    CREATE TABLE blocked_phones (
      phone text PRIMARY KEY,
      reason text CHECK (length(reason) <= 200),
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);

  await sql`
    CREATE TABLE audit_log (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      action text NOT NULL,
      entity text,
      entity_id text,
      details jsonb NOT NULL DEFAULT '{}',
      ip text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC)`.execute(db);
  await sql`CREATE INDEX audit_log_user_idx ON audit_log (user_id, created_at DESC)`.execute(db);

  await sql`
    CREATE TABLE whatsapp_webhook_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      received_at timestamptz NOT NULL DEFAULT now(),
      payload jsonb NOT NULL
    )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'whatsapp_webhook_events',
    'audit_log',
    'blocked_phones',
    'import_rejections',
    'lead_events',
    'leads',
    'lists',
    'imports',
    'message_templates',
    'settings',
    'password_tokens',
    'sessions',
    'users',
  ]) {
    await sql`DROP TABLE IF EXISTS ${sql.table(t)} CASCADE`.execute(db);
  }
}
