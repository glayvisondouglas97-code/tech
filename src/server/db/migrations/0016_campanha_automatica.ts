import { type Kysely, sql } from 'kysely';

/**
 * Campanha automática pré-definida pelo sistema (o gestor só clica em Ativar ou Pausar).
 *
 * - `automations.system_key`: marca a automação que o PRÓPRIO sistema cria e mantém (uma etapa: áudio sorteado da
 *   biblioteca). Ninguém a edita, arquiva ou apaga pela API genérica. O nome dela não disputa o índice de nomes.
 * - `automation_campaigns.all_lists`: o público é a fila livre de TODAS as listas não arquivadas (sem `list_id`).
 * - `automation_campaigns.all_numbers`: os números são TODOS os cadastrados, lidos a cada ciclo (número novo entra
 *   sozinho; excluído sai sozinho). Nesse modo `instance_ids` fica vazio.
 * - `automation_campaigns.daily_limit`: o teto passa a ser o mesmo da cota do número (20), como o sistema já fazia.
 * - `wa_conversations.contact_claimed_at`: quem segurou a vaga do PRIMEIRO contato desta conversa. Dois envios ao mesmo
 *   tempo na mesma conversa nova (clique duplo no Chamar, áudio e texto juntos) passam a gastar UMA vaga, não duas.
 *
 * As automações montadas à mão (tela antiga) são ARQUIVADAS e as campanhas vivas delas, encerradas: a tela delas saiu
 * do sistema e nada pode continuar enviando sem aparecer em lugar nenhum. O histórico (etapas, participações,
 * mensagens) fica; as participações em andamento são canceladas pelo job no ciclo seguinte (automação arquivada).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automations ADD COLUMN system_key text CHECK (length(system_key) BETWEEN 1 AND 60)`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX automations_system_key ON automations (system_key) WHERE system_key IS NOT NULL`.execute(
    db,
  );
  await sql`DROP INDEX automations_name_key`.execute(db);
  await sql`CREATE UNIQUE INDEX automations_name_key ON automations (lower(name))
    WHERE archived_at IS NULL AND system_key IS NULL`.execute(db);

  await sql`ALTER TABLE automation_campaigns
    ADD COLUMN all_lists boolean NOT NULL DEFAULT false,
    ADD COLUMN all_numbers boolean NOT NULL DEFAULT false`.execute(db);
  await sql`ALTER TABLE automation_campaigns DROP CONSTRAINT automation_campaigns_instance_ids_check`.execute(
    db,
  );
  await sql`ALTER TABLE automation_campaigns ADD CONSTRAINT automation_campaigns_numbers_check
    CHECK (all_numbers OR cardinality(instance_ids) BETWEEN 1 AND 20)`.execute(db);
  await sql`ALTER TABLE automation_campaigns ADD CONSTRAINT automation_campaigns_lists_check
    CHECK (NOT all_lists OR list_id IS NULL)`.execute(db);
  await sql`UPDATE automation_campaigns SET daily_limit = LEAST(daily_limit, 20) WHERE daily_limit > 20`.execute(
    db,
  );
  await sql`ALTER TABLE automation_campaigns DROP CONSTRAINT automation_campaigns_daily_limit_check`.execute(
    db,
  );
  await sql`ALTER TABLE automation_campaigns ADD CONSTRAINT automation_campaigns_daily_limit_check
    CHECK (daily_limit BETWEEN 1 AND 20)`.execute(db);

  await sql`ALTER TABLE wa_conversations ADD COLUMN contact_claimed_at timestamptz`.execute(db);

  // A tela de montar automações saiu: o que foi montado nela para de enviar (o histórico fica).
  await sql`UPDATE automation_campaigns
    SET status = 'stopped', ended_at = now(), end_reason = 'substituida_campanha_automatica', updated_at = now()
    WHERE status IN ('active', 'paused')`.execute(db);
  await sql`UPDATE automations SET status = 'archived', archived_at = now(), updated_at = now()
    WHERE archived_at IS NULL AND system_key IS NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE wa_conversations DROP COLUMN IF EXISTS contact_claimed_at`.execute(db);
  await sql`ALTER TABLE automation_campaigns DROP CONSTRAINT IF EXISTS automation_campaigns_daily_limit_check`.execute(
    db,
  );
  await sql`ALTER TABLE automation_campaigns ADD CONSTRAINT automation_campaigns_daily_limit_check
    CHECK (daily_limit BETWEEN 1 AND 500)`.execute(db);
  await sql`ALTER TABLE automation_campaigns DROP CONSTRAINT IF EXISTS automation_campaigns_lists_check`.execute(
    db,
  );
  await sql`ALTER TABLE automation_campaigns DROP CONSTRAINT IF EXISTS automation_campaigns_numbers_check`.execute(
    db,
  );
  await sql`DELETE FROM automation_campaigns WHERE all_numbers OR all_lists`.execute(db);
  await sql`ALTER TABLE automation_campaigns ADD CONSTRAINT automation_campaigns_instance_ids_check
    CHECK (cardinality(instance_ids) BETWEEN 1 AND 20)`.execute(db);
  await sql`ALTER TABLE automation_campaigns DROP COLUMN IF EXISTS all_numbers, DROP COLUMN IF EXISTS all_lists`.execute(
    db,
  );
  await sql`DROP INDEX IF EXISTS automations_name_key`.execute(db);
  await sql`DELETE FROM automations WHERE system_key IS NOT NULL`.execute(db);
  await sql`CREATE UNIQUE INDEX automations_name_key ON automations (lower(name)) WHERE archived_at IS NULL`.execute(
    db,
  );
  await sql`DROP INDEX IF EXISTS automations_system_key`.execute(db);
  await sql`ALTER TABLE automations DROP COLUMN IF EXISTS system_key`.execute(db);
}
