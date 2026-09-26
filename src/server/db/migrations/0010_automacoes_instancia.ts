import { type Kysely, sql } from 'kysely';

/**
 * Executor das automações: a participação de um lead guarda POR QUAL NÚMERO de WhatsApp a automação fala
 * e QUEM a iniciou.
 * - instance_id: no gatilho "lead_called" é exatamente o número que fez o "Chamar"; na execução manual, o
 *   número escolhido. Sem isso o executor teria de adivinhar por qual conversa falar. Se o número for
 *   excluído, fica vazio (SET NULL) e o executor cancela a participação em vez de escolher outro.
 * - started_by: a pessoa que chamou o lead (ou que iniciou a execução manual). Serve para a variável
 *   {{atendente}} e para a auditoria.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_runs
    ADD COLUMN instance_id int REFERENCES wa_instances(id) ON DELETE SET NULL`.execute(db);
  await sql`ALTER TABLE automation_runs
    ADD COLUMN started_by uuid REFERENCES users(id) ON DELETE SET NULL`.execute(db);
  // Excluir um número ou uma pessoa procura as participações que os usam.
  await sql`CREATE INDEX automation_runs_instance_idx ON automation_runs (instance_id) WHERE instance_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX automation_runs_started_by_idx ON automation_runs (started_by) WHERE started_by IS NOT NULL`.execute(
    db,
  );
  // A resposta do lead cancela só as participações daquele lead naquele número (webhook).
  await sql`CREATE INDEX automation_runs_live_lead_idx ON automation_runs (lead_id, instance_id)
    WHERE status IN ('pending', 'running')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_runs DROP COLUMN IF EXISTS started_by`.execute(db);
  await sql`ALTER TABLE automation_runs DROP COLUMN IF EXISTS instance_id`.execute(db);
}
