import { type Kysely, sql } from 'kysely';

/**
 * Áudio sorteado nas etapas (campanhas de primeiro contato):
 * - automation_steps.audio_mode: "fixed" (o áudio escolhido, audio_id) ou "random" (sorteia entre os áudios ativos
 *   da biblioteca; nesse modo a etapa não guarda áudio fixo).
 * - automation_step_runs.audio_id / audio_label: QUAL áudio foi usado naquela tentativa. O áudio é escolhido e
 *   gravado ANTES de chamar a Evolution; o nome fica também como texto, para o histórico sobreviver se o áudio
 *   for excluído da biblioteca (audio_id vira vazio, SET NULL).
 * - wa_audio_bags: o "saco embaralhado" do rodízio, guardado no banco (sobrevive a reinício e a vários processos).
 *   Cada escopo (uma campanha, uma automação, um número do Chamar) tem a sua ordem restante.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_steps
    ADD COLUMN audio_mode text NOT NULL DEFAULT 'fixed' CHECK (audio_mode IN ('fixed', 'random'))`.execute(
    db,
  );
  // No sorteio não há áudio fixo, e só a etapa de áudio pode sortear.
  await sql`ALTER TABLE automation_steps ADD CONSTRAINT automation_steps_audio_random_check
    CHECK (audio_mode = 'fixed' OR (action_type = 'send_audio' AND audio_id IS NULL))`.execute(db);

  await sql`ALTER TABLE automation_step_runs
    ADD COLUMN audio_id int REFERENCES wa_audios(id) ON DELETE SET NULL`.execute(db);
  await sql`ALTER TABLE automation_step_runs ADD COLUMN audio_label text`.execute(db);
  await sql`CREATE INDEX automation_step_runs_audio_idx ON automation_step_runs (audio_id) WHERE audio_id IS NOT NULL`.execute(
    db,
  );

  await sql`
    CREATE TABLE wa_audio_bags (
      scope text PRIMARY KEY,
      -- Ids dos áudios que ainda faltam sair neste ciclo, na ordem em que saem.
      remaining int[] NOT NULL DEFAULT '{}',
      last_audio_id int,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS wa_audio_bags`.execute(db);
  await sql`ALTER TABLE automation_step_runs DROP COLUMN IF EXISTS audio_label`.execute(db);
  await sql`ALTER TABLE automation_step_runs DROP COLUMN IF EXISTS audio_id`.execute(db);
  await sql`ALTER TABLE automation_steps DROP COLUMN IF EXISTS audio_mode`.execute(db);
}
