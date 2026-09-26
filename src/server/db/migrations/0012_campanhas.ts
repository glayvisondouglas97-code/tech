import { type Kysely, sql } from 'kysely';

/**
 * Campanhas de automação: iniciar uma automação para os leads de uma lista, sem ninguém clicar em "Chamar".
 *
 * - automation_campaigns guarda SÓ o estado da campanha (automação, lista, números permitidos, janela de horário,
 *   limite diário por número, quem iniciou, situação). Os leads NÃO são copiados: uma lista de 100 mil leads não
 *   vira 100 mil linhas. O job reserva um lead por vez, por número, conforme houver capacidade.
 * - automation_runs ganha campaign_id (de qual campanha veio a participação) e slot_date (o DIA, em São Paulo, em
 *   que ela ocupou uma vaga do número). O limite "N leads por número por dia" é a contagem dessas linhas: fica no
 *   PostgreSQL, sobrevive a reinício e a vários processos, e o dia novo começa zerado sozinho.
 * - Um lead nunca entra duas vezes na mesma campanha (índice único) e só há uma campanha viva por automação.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE automation_campaigns (
      id serial PRIMARY KEY,
      automation_id int NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      -- Se a lista for excluída, a campanha continua no histórico (o job a encerra).
      list_id uuid REFERENCES lists(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped', 'finished')),
      -- Números permitidos (wa_instances.id). Número excluído deixa de ser encontrado e sai do pool sozinho.
      instance_ids int[] NOT NULL CHECK (cardinality(instance_ids) BETWEEN 1 AND 20),
      -- Janela de envio, em minutos desde a meia-noite de São Paulo: [início, fim).
      window_start_min int NOT NULL CHECK (window_start_min BETWEEN 0 AND 1439),
      window_end_min int NOT NULL CHECK (window_end_min BETWEEN 1 AND 1440),
      -- Novos leads por número por dia (separado do limite de leads que o atendente pode pegar).
      daily_limit int NOT NULL CHECK (daily_limit BETWEEN 1 AND 500),
      started_by uuid REFERENCES users(id) ON DELETE SET NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      end_reason text CHECK (length(end_reason) <= 200),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT automation_campaigns_window_check CHECK (window_start_min < window_end_min),
      CONSTRAINT automation_campaigns_ended_check CHECK ((status IN ('stopped', 'finished')) = (ended_at IS NOT NULL))
    )`.execute(db);
  // Uma campanha viva (ativa ou pausada) por automação: clique duplo ou dois pedidos não criam duas.
  await sql`CREATE UNIQUE INDEX automation_campaigns_live_key ON automation_campaigns (automation_id)
    WHERE status IN ('active', 'paused')`.execute(db);
  await sql`CREATE INDEX automation_campaigns_active_idx ON automation_campaigns (id) WHERE status = 'active'`.execute(
    db,
  );
  await sql`CREATE INDEX automation_campaigns_list_idx ON automation_campaigns (list_id) WHERE list_id IS NOT NULL`.execute(
    db,
  );

  await sql`ALTER TABLE automation_runs
    ADD COLUMN campaign_id int REFERENCES automation_campaigns(id) ON DELETE SET NULL`.execute(db);
  await sql`ALTER TABLE automation_runs ADD COLUMN slot_date date`.execute(db);
  await sql`ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_campaign_slot_check
    CHECK (campaign_id IS NULL OR slot_date IS NOT NULL)`.execute(db);
  // Um lead, uma vez por campanha (mesmo que a participação tenha sido cancelada ou falhado).
  await sql`CREATE UNIQUE INDEX automation_runs_campaign_lead_key ON automation_runs (campaign_id, lead_id)
    WHERE campaign_id IS NOT NULL`.execute(db);
  await sql`CREATE INDEX automation_runs_campaign_idx ON automation_runs (campaign_id, status)
    WHERE campaign_id IS NOT NULL`.execute(db);
  // Contagem do dia de cada número: quantos leads de campanha ele recebeu hoje.
  await sql`CREATE INDEX automation_runs_slot_idx ON automation_runs (instance_id, slot_date)
    WHERE campaign_id IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_runs DROP COLUMN IF EXISTS slot_date`.execute(db);
  await sql`ALTER TABLE automation_runs DROP COLUMN IF EXISTS campaign_id`.execute(db);
  await sql`DROP TABLE IF EXISTS automation_campaigns`.execute(db);
}
