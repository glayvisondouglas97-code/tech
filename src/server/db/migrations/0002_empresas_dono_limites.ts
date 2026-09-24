import { type Kysely, sql } from 'kysely';

const OLD_TEMPLATE =
  'Olá, {nome}! Tudo bem? Aqui é {atendente}. Vi que você demonstrou interesse e queria te passar mais informações. Posso te ajudar?';
const NEW_TEMPLATE =
  'Olá, {nome}! Tudo bem? Aqui é {atendente}. Estou entrando em contato com a {empresa} porque temos uma proposta que pode interessar. Posso te passar mais informações?';

/**
 * - Papel "dono" (acesso master) acima do administrador; o primeiro administrador vira dono.
 * - Leads de pessoa jurídica: nome da empresa (o "name" passa a ser o sócio/proprietário).
 * - DDD calculado do telefone, para pegar leads só de um DDD.
 * - Limite diário de leads por atendente (padrão da empresa + individual).
 * - Novos resultados de contato.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`.execute(db);
  await sql`ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('dono', 'admin', 'supervisor', 'atendente'))`.execute(db);
  await sql`UPDATE users SET role = 'dono'
    WHERE id = (SELECT id FROM users WHERE role = 'admin' AND active ORDER BY created_at LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'dono')`.execute(db);
  await sql`ALTER TABLE users ADD COLUMN daily_pull_limit int
    CHECK (daily_pull_limit BETWEEN 0 AND 100000)`.execute(db);

  await sql`ALTER TABLE settings ADD COLUMN daily_pull_limit int NOT NULL DEFAULT 0
    CHECK (daily_pull_limit BETWEEN 0 AND 100000)`.execute(db);
  await sql`ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pull_size_check`.execute(db);
  await sql`ALTER TABLE settings ADD CONSTRAINT settings_pull_size_check CHECK (pull_size BETWEEN 1 AND 1000)`.execute(
    db,
  );

  await sql`ALTER TABLE leads ADD COLUMN company text NOT NULL DEFAULT ''`.execute(db);
  await sql`ALTER TABLE leads ADD COLUMN company_search text NOT NULL DEFAULT ''`.execute(db);
  await sql`ALTER TABLE leads ADD COLUMN ddd text GENERATED ALWAYS AS (
    CASE WHEN phone ~ '^55[1-9][0-9][0-9]{8,9}$' THEN substr(phone, 3, 2) END) STORED`.execute(db);
  await sql`CREATE INDEX leads_company_trgm_idx ON leads USING gin (company_search gin_trgm_ops)`.execute(db);
  await sql`CREATE INDEX leads_free_ddd_idx ON leads (ddd, id) WHERE status = 'pendente' AND assigned_to IS NULL`.execute(
    db,
  );

  await sql`ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_result_check`.execute(db);
  await sql`ALTER TABLE leads ADD CONSTRAINT leads_result_check CHECK (result IN (
    'enviado', 'respondeu', 'nao_respondeu', 'interessado', 'fechou',
    'sem_conta', 'nao_correntista', 'sem_interesse', 'sem_whatsapp'))`.execute(db);

  await sql`CREATE INDEX lead_events_created_idx ON lead_events (created_at DESC)`.execute(db);
  await sql`CREATE INDEX audit_log_action_idx ON audit_log (action, created_at DESC)`.execute(db);

  await sql`UPDATE message_templates SET body = ${NEW_TEMPLATE} WHERE body = ${OLD_TEMPLATE}`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS audit_log_action_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS lead_events_created_idx`.execute(db);
  await sql`ALTER TABLE leads DROP COLUMN IF EXISTS ddd`.execute(db);
  await sql`ALTER TABLE leads DROP COLUMN IF EXISTS company_search`.execute(db);
  await sql`ALTER TABLE leads DROP COLUMN IF EXISTS company`.execute(db);
  await sql`ALTER TABLE settings DROP COLUMN IF EXISTS daily_pull_limit`.execute(db);
  await sql`ALTER TABLE users DROP COLUMN IF EXISTS daily_pull_limit`.execute(db);
  await sql`UPDATE users SET role = 'admin' WHERE role = 'dono'`.execute(db);
}
