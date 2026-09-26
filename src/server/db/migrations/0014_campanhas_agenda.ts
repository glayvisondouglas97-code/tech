import { type Kysely, sql } from 'kysely';

/**
 * Agenda e público das campanhas (Fase 6). Só AMPLIA `automation_campaigns`; nada é removido.
 *
 * - `start_date` / `end_date`: datas no calendário de São Paulo. Antes da data inicial a campanha fica "agendada" (nenhum
 *   contato); depois da data final não cria mais primeiros contatos. "Agendada" NÃO é um estado novo guardado: é
 *   `status = 'active'` com `start_date` no futuro, então nada precisa "virar o estado" quando o dia chega.
 * - `days_of_week`: dias em que a campanha executa (ISO: 1 = segunda ... 7 = domingo). As campanhas que já existiam
 *   continuam executando todos os dias; as novas nascem de segunda a sexta.
 * - `cooldown_hours`: depois de um primeiro contato automático, uma nova abordagem INDEPENDENTE do mesmo lead só depois
 *   desse tempo. Não bloqueia as etapas seguintes da mesma execução. 0 = sem cooldown.
 * - `filters` (JSONB): filtros opcionais do público (DDD, situação, resultado, tipo de telefone, chamado antes). Só o que
 *   restringe fica guardado.
 *
 * O horário de trabalho continua nas colunas `window_start_min` / `window_end_min` (minutos desde a meia-noite).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_campaigns ADD COLUMN start_date date`.execute(db);
  // As que já existiam começaram no dia em que foram iniciadas (em São Paulo).
  await sql`UPDATE automation_campaigns SET start_date = (started_at AT TIME ZONE 'America/Sao_Paulo')::date`.execute(
    db,
  );
  await sql`ALTER TABLE automation_campaigns ALTER COLUMN start_date SET NOT NULL`.execute(db);
  await sql`ALTER TABLE automation_campaigns ADD COLUMN end_date date`.execute(db);
  await sql`ALTER TABLE automation_campaigns ADD CONSTRAINT automation_campaigns_dates_check
    CHECK (end_date IS NULL OR end_date >= start_date)`.execute(db);

  // Campanhas antigas: todos os dias (o que elas já faziam). Novas: segunda a sexta.
  await sql`ALTER TABLE automation_campaigns ADD COLUMN days_of_week smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}'`.execute(
    db,
  );
  await sql`ALTER TABLE automation_campaigns ALTER COLUMN days_of_week SET DEFAULT '{1,2,3,4,5}'`.execute(db);
  await sql`ALTER TABLE automation_campaigns ADD CONSTRAINT automation_campaigns_days_check
    CHECK (cardinality(days_of_week) BETWEEN 1 AND 7 AND days_of_week <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[])`.execute(
    db,
  );

  await sql`ALTER TABLE automation_campaigns ADD COLUMN cooldown_hours int NOT NULL DEFAULT 24
    CHECK (cooldown_hours BETWEEN 0 AND 720)`.execute(db);
  await sql`ALTER TABLE automation_campaigns ADD COLUMN filters jsonb NOT NULL DEFAULT '{}'::jsonb`.execute(
    db,
  );
  await sql`ALTER TABLE automation_campaigns ADD CONSTRAINT automation_campaigns_filters_check
    CHECK (jsonb_typeof(filters) = 'object')`.execute(db);

  // O cooldown consulta o primeiro contato automático de cada lead: participações de campanha por lead.
  await sql`CREATE INDEX automation_runs_campaign_lead_idx ON automation_runs (lead_id) WHERE campaign_id IS NOT NULL`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS automation_runs_campaign_lead_idx`.execute(db);
  await sql`ALTER TABLE automation_campaigns DROP COLUMN IF EXISTS filters`.execute(db);
  await sql`ALTER TABLE automation_campaigns DROP COLUMN IF EXISTS cooldown_hours`.execute(db);
  await sql`ALTER TABLE automation_campaigns DROP COLUMN IF EXISTS days_of_week`.execute(db);
  await sql`ALTER TABLE automation_campaigns DROP COLUMN IF EXISTS end_date`.execute(db);
  await sql`ALTER TABLE automation_campaigns DROP COLUMN IF EXISTS start_date`.execute(db);
}
