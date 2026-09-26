import { type Kysely, sql } from 'kysely';

/**
 * Preenche a cota diária (`wa_instance_daily_usage`) do DIA EM QUE ESTA MIGRAÇÃO É APLICADA (dia de São Paulo) com o que já
 * aconteceu nesse dia, para que o número não comece em 0/20 quando já fez contatos antes da cota existir. Só esse dia:
 * dias anteriores NÃO são recalculados (a estrutura antiga não permite classificar todo contato histórico com segurança).
 *
 * O que conta como CONTATO (a mesma definição que a cota usa em tempo real: o PRIMEIRO contato que o sistema inicia com um
 * lead), só com evidência estrutural que já existe no banco:
 *
 * - MANUAL: mensagem enviada por uma PESSOA pelo sistema (`wa_messages.sent_by` preenchido, `from_me`), numa conversa ligada
 *   a um lead (`wa_conversations.lead_id`), que é a PRIMEIRA mensagem da conversa (nenhuma mensagem antes, nem recebida nem
 *   enviada). É o "Chamar" com áudio, ou a primeira mensagem digitada para o lead, exatamente como `sendAndStore` decide.
 * - AUTOMÁTICO: a mensagem da PRIMEIRA etapa de uma participação (a primeira tentativa da participação, concluída, ligada à
 *   mensagem por `automation_step_runs.message_id`) de uma campanha ou de uma execução do gatilho "manual", numa conversa
 *   ligada ao mesmo lead. É o que o executor segura como contato automático.
 *
 * NÃO conta (é preferível subcontar a inventar): mensagens recebidas; respostas; mensagens de continuação; mensagens enviadas
 * direto pelo celular (`sent_by` vazio e sem etapa ligada: não dá para saber se foram primeiro contato); etapas seguintes
 * (follow-up) e o gatilho "lead chamado" (o Chamar que o disparou já contou); conversas sem lead; envios de outros dias.
 * `uncertain_contacts` não é estimado: o que já estiver gravado na linha do dia é mantido como está.
 *
 * SEGURA PARA REPETIR: a linha do dia é RECALCULADA (não somada): manual e automático viram o maior entre o que já estava gravado
 * e o que o histórico prova, o incerto é mantido. Rodar de novo dá o mesmo resultado. O total nunca passa de 20 (a trava do
 * banco); se o histórico do dia tiver mais que isso, a linha fica em 20/20, que é o resultado conservador.
 */
const LIMIT = 20;

/** Recalcula a linha do dia `date` (AAAA-MM-DD, calendário de São Paulo) de cada número que tem contatos provados. */
export async function backfillQuotaDay<DB>(db: Kysely<DB>, date: string): Promise<number> {
  const written = await sql<{ instance_id: number }>`
    WITH bounds AS (
      SELECT (${date}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo' AS day_start,
             ((${date}::date + 1)::timestamp) AT TIME ZONE 'America/Sao_Paulo' AS day_end
    ),
    manual AS (
      SELECT m.instance_id, count(*)::int AS n
      FROM wa_messages m
      JOIN wa_conversations c ON c.id = m.conversation_id AND c.instance_id = m.instance_id
      JOIN leads l ON l.id = c.lead_id
      CROSS JOIN bounds b
      WHERE m.from_me AND m.sent_by IS NOT NULL
        AND m.sent_at >= b.day_start AND m.sent_at < b.day_end
        AND NOT EXISTS (
          SELECT 1 FROM wa_messages o
          WHERE o.conversation_id = m.conversation_id AND o.id <> m.id AND (o.id < m.id OR o.sent_at < m.sent_at))
        AND NOT EXISTS (SELECT 1 FROM automation_step_runs sr WHERE sr.message_id = m.id)
      GROUP BY m.instance_id
    ),
    automatic AS (
      SELECT m.instance_id, count(*)::int AS n
      FROM automation_step_runs sr
      JOIN automation_runs r ON r.id = sr.automation_run_id
      JOIN automations a ON a.id = r.automation_id
      JOIN wa_messages m ON m.id = sr.message_id
      JOIN wa_conversations c ON c.id = m.conversation_id AND c.instance_id = m.instance_id AND c.lead_id = r.lead_id
      CROSS JOIN bounds b
      WHERE sr.status = 'completed' AND m.from_me
        AND sr.id = (SELECT min(x.id) FROM automation_step_runs x WHERE x.automation_run_id = r.id)
        AND (r.campaign_id IS NOT NULL OR a.trigger_type = 'manual')
        AND m.sent_at >= b.day_start AND m.sent_at < b.day_end
      GROUP BY m.instance_id
    ),
    found AS (
      SELECT instance_id FROM manual UNION SELECT instance_id FROM automatic
    ),
    calc AS (
      SELECT f.instance_id,
             LEAST(COALESCE(u.uncertain_contacts, 0), ${LIMIT}::int) AS unc,
             GREATEST(COALESCE(u.manual_contacts, 0), COALESCE(mn.n, 0)) AS man_raw,
             GREATEST(COALESCE(u.automatic_contacts, 0), COALESCE(au.n, 0)) AS aut_raw
      FROM found f
      JOIN wa_instances i ON i.id = f.instance_id
      LEFT JOIN manual mn ON mn.instance_id = f.instance_id
      LEFT JOIN automatic au ON au.instance_id = f.instance_id
      LEFT JOIN wa_instance_daily_usage u ON u.instance_id = f.instance_id AND u.usage_date = ${date}::date
    ),
    final AS (
      SELECT instance_id, unc,
             LEAST(man_raw, ${LIMIT}::int - unc) AS man,
             LEAST(aut_raw, ${LIMIT}::int - unc - LEAST(man_raw, ${LIMIT}::int - unc)) AS aut
      FROM calc
    )
    INSERT INTO wa_instance_daily_usage AS d
      (instance_id, usage_date, manual_contacts, automatic_contacts, uncertain_contacts, total_contacts)
    SELECT instance_id, ${date}::date, man, aut, unc, man + aut + unc FROM final
    ON CONFLICT (instance_id, usage_date) DO UPDATE
      SET manual_contacts = EXCLUDED.manual_contacts,
          automatic_contacts = EXCLUDED.automatic_contacts,
          uncertain_contacts = EXCLUDED.uncertain_contacts,
          total_contacts = EXCLUDED.total_contacts,
          updated_at = now()
    RETURNING d.instance_id`.execute(db);
  return written.rows.length;
}

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  // "Hoje" é o dia de São Paulo (o banco pode estar em UTC): nunca CURRENT_DATE.
  const today = await sql<{ d: string }>`
    SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS d`.execute(db);
  await backfillQuotaDay(db, today.rows[0]?.d as string);
}

/** Migração de dados: não há como saber quais linhas vieram daqui, então não há o que desfazer. */
export async function down<DB>(_db: Kysely<DB>): Promise<void> {}
