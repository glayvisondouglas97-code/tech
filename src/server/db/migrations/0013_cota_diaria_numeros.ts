import { type Kysely, sql } from 'kysely';

/**
 * Cota diária de contatos por número de WhatsApp: UMA tabela que serve ao Chamar (manual) e às campanhas (automático).
 *
 * - Uma linha por número e por dia de São Paulo (`UNIQUE (instance_id, usage_date)`). O dia novo cria a linha nova
 *   sozinho: ninguém zera contador.
 * - `manual_contacts` e `automatic_contacts` só contam o que foi ENVIADO. `uncertain_contacts` guarda a vaga que foi
 *   segurada para um envio em andamento (ou de resultado incerto): ela ocupa a cota, mas só vira manual/automático
 *   quando o envio é confirmado, e só é devolvida quando se SABE que a mensagem não saiu.
 * - `total_contacts = manual + automático + incerto`, e `total_contacts <= 20` é uma trava do PRÓPRIO banco: mesmo que
 *   um bug no código tentasse, o 21º contato do dia não é gravado.
 * - Reservar um lead (`automation_runs.slot_date`, `next_run_at`) é PLANEJAMENTO e não passa por aqui: a cota reflete
 *   os contatos feitos no dia em que aconteceram.
 * - Não é preenchida com o que aconteceu antes desta migração: a contagem começa no dia em que ela é aplicada.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE wa_instance_daily_usage (
      id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      instance_id int NOT NULL REFERENCES wa_instances(id) ON DELETE CASCADE,
      usage_date date NOT NULL,
      manual_contacts int NOT NULL DEFAULT 0,
      automatic_contacts int NOT NULL DEFAULT 0,
      uncertain_contacts int NOT NULL DEFAULT 0,
      total_contacts int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT wa_instance_daily_usage_key UNIQUE (instance_id, usage_date),
      CONSTRAINT wa_instance_daily_usage_nonneg
        CHECK (manual_contacts >= 0 AND automatic_contacts >= 0 AND uncertain_contacts >= 0),
      CONSTRAINT wa_instance_daily_usage_total
        CHECK (total_contacts = manual_contacts + automatic_contacts + uncertain_contacts),
      CONSTRAINT wa_instance_daily_usage_max CHECK (total_contacts <= 20)
    )`.execute(db);
  await sql`CREATE INDEX wa_instance_daily_usage_date_idx ON wa_instance_daily_usage (usage_date)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS wa_instance_daily_usage`.execute(db);
}
