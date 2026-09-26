import { type Kysely, sql } from 'kysely';

/**
 * Automações (só o banco: nada aqui envia mensagem nem agenda tarefa).
 *
 *   automations ─┬─ automation_steps
 *                └─ automation_runs ── automation_step_runs ─(message_id)→ wa_messages
 *
 * - automations: a automação em si. Arquivar guarda a data em archived_at e nada é apagado.
 * - automation_steps: as etapas em ordem (position). Cada etapa tem um atraso, o texto (quando envia texto)
 *   e as condições em JSON (só guardadas por enquanto).
 * - automation_runs: a participação de um lead numa automação (em que etapa está e quando age de novo).
 * - automation_step_runs: o histórico de cada tentativa de uma etapa, com a mensagem enviada por ela.
 *
 * Apagar uma automação leva junto etapas e participações (o sistema só arquiva). Apagar um lead (LGPD) leva
 * as participações dele. Apagar uma etapa ou uma mensagem NÃO apaga o histórico: o vínculo só fica vazio.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE automations (
      id serial PRIMARY KEY,
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
      description text CHECK (length(description) <= 500),
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
      trigger_type text NOT NULL CHECK (trigger_type IN ('lead_called', 'lead_created', 'manual')),
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz,
      CONSTRAINT automations_archived_check CHECK ((status = 'archived') = (archived_at IS NOT NULL))
    )`.execute(db);
  await sql`CREATE INDEX automations_status_idx ON automations (status)`.execute(db);
  await sql`CREATE INDEX automations_created_by_idx ON automations (created_by)`.execute(db);
  // Lista normal: só as que não foram arquivadas, das mais novas para as mais antigas.
  await sql`CREATE INDEX automations_open_idx ON automations (id DESC) WHERE archived_at IS NULL`.execute(db);
  // Nome único entre as que não foram arquivadas, sem diferenciar maiúsculas (nas letras acentuadas isso
  // depende do idioma do banco, como no índice de e-mail); arquivar libera o nome.
  await sql`CREATE UNIQUE INDEX automations_name_key ON automations (lower(name)) WHERE archived_at IS NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE automation_steps (
      id serial PRIMARY KEY,
      automation_id int NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      position int NOT NULL CHECK (position >= 1),
      action_type text NOT NULL CHECK (action_type IN ('send_text', 'send_audio')),
      delay_seconds int NOT NULL DEFAULT 0 CHECK (delay_seconds BETWEEN 0 AND 31536000),
      message_text text CHECK (length(message_text) <= 4096),
      conditions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(conditions) = 'array'),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      -- Adiável: reordenar as etapas (trocar duas de lugar) numa transação só não esbarra na unicidade.
      CONSTRAINT automation_steps_position_key UNIQUE (automation_id, position) DEFERRABLE INITIALLY IMMEDIATE,
      -- coalesce: sem ele, texto nulo daria NULL e o CHECK deixaria passar.
      CONSTRAINT automation_steps_text_check
        CHECK (action_type <> 'send_text' OR coalesce(length(btrim(message_text)), 0) > 0)
    )`.execute(db);

  await sql`
    CREATE TABLE automation_runs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      automation_id int NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      lead_id bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'cancelled', 'failed')),
      -- Posição (automation_steps.position) da etapa em andamento: a próxima a executar.
      current_step int NOT NULL DEFAULT 1 CHECK (current_step >= 1),
      started_at timestamptz,
      completed_at timestamptz,
      cancelled_at timestamptz,
      cancel_reason text CHECK (length(cancel_reason) <= 200),
      -- Quando a etapa em andamento deve agir (o scheduler busca por aqui).
      next_run_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT automation_runs_completed_check CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
      CONSTRAINT automation_runs_cancelled_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
    )`.execute(db);
  await sql`CREATE INDEX automation_runs_automation_idx ON automation_runs (automation_id, status)`.execute(
    db,
  );
  await sql`CREATE INDEX automation_runs_lead_idx ON automation_runs (lead_id)`.execute(db);
  await sql`CREATE INDEX automation_runs_status_idx ON automation_runs (status)`.execute(db);
  // O que o scheduler vai buscar: participações em andamento, pela hora em que devem agir.
  await sql`CREATE INDEX automation_runs_due_idx ON automation_runs (next_run_at)
    WHERE status IN ('pending', 'running') AND next_run_at IS NOT NULL`.execute(db);
  // Um lead não participa duas vezes ao mesmo tempo da mesma automação (evita mensagem em dobro).
  // Depois de concluída, cancelada ou com falha, ele pode entrar de novo.
  await sql`CREATE UNIQUE INDEX automation_runs_live_key ON automation_runs (automation_id, lead_id)
    WHERE status IN ('pending', 'running')`.execute(db);

  await sql`
    CREATE TABLE automation_step_runs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      automation_run_id bigint NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      -- Some se a etapa for apagada; o histórico do que aconteceu fica.
      step_id int REFERENCES automation_steps(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'cancelled', 'failed', 'skipped')),
      scheduled_at timestamptz NOT NULL,
      started_at timestamptz,
      finished_at timestamptz,
      attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      error text,
      -- Mensagem enviada por esta etapa. Some se a mensagem for apagada (conversa ou número excluído).
      message_id int REFERENCES wa_messages(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX automation_step_runs_run_idx ON automation_step_runs (automation_run_id)`.execute(
    db,
  );
  await sql`CREATE INDEX automation_step_runs_step_idx ON automation_step_runs (step_id) WHERE step_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX automation_step_runs_message_idx ON automation_step_runs (message_id) WHERE message_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX automation_step_runs_due_idx ON automation_step_runs (scheduled_at) WHERE status = 'pending'`.execute(
    db,
  );
  // Cada etapa roda uma vez por participação (as novas tentativas somam em "attempts").
  await sql`CREATE UNIQUE INDEX automation_step_runs_once_key ON automation_step_runs (automation_run_id, step_id)
    WHERE step_id IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS automation_step_runs, automation_runs, automation_steps, automations`.execute(
    db,
  );
}
