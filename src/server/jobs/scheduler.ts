import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../db';
import { runAutomationCycle } from '../modules/automations/executor';
import { advanceCampaigns } from '../modules/automations/queue';
import { CYCLE_SECONDS } from '../modules/automations/schedule';
import { recoverStaleImports } from '../modules/imports/service';
import { releaseLeads } from '../modules/leads/service';
import { getSettings } from '../modules/settings/service';
import { publishCampaignChange } from '../modules/whatsapp/realtime';

const JOB_LOCK = 720_002;
/** Trava própria das automações: um envio lento não segura a limpeza nem a devolução de leads (e vice-versa). */
const AUTOMATION_LOCK = 720_003;

/** Roda a tarefa só em um servidor por vez (se houver mais de um). */
async function exclusive(db: Db, fn: () => Promise<void>, lock = JOB_LOCK): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const r = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(${lock}) AS ok`.execute(trx);
    if (r.rows[0]?.ok) await fn();
  });
}

/** Leads que o atendente pegou e não abriu no WhatsApp voltam para a fila livre depois de X horas. */
export async function expireStaleLeads(db: Db): Promise<number> {
  const s = await getSettings(db);
  if (s.expire_hours <= 0) return 0;
  return releaseLeads(db, null, {
    olderThanHours: s.expire_hours,
    onlyNotOpened: true,
    onlyPulled: true,
    reason: `parado há mais de ${s.expire_hours} horas`,
  });
}

/** Limpeza e retenção de dados (LGPD). Prazos descritos em docs/LGPD.md. */
export async function cleanup(db: Db): Promise<void> {
  await db.deleteFrom('sessions').where('expires_at', '<', new Date()).execute();
  await db
    .deleteFrom('password_tokens')
    .where(
      sql<boolean>`(used_at IS NOT NULL OR expires_at < now()) AND created_at < now() - interval '30 days'`,
    )
    .execute();
  // Rascunhos de importação abandonados: apaga o arquivo depois de 1 dia.
  await db
    .updateTable('imports')
    .set({ status: 'descartada', file_data: null })
    .where('status', '=', 'rascunho')
    .where('created_at', '<', sql<Date>`now() - interval '1 day'`)
    .execute();
  await db
    .updateTable('imports')
    .set({ file_data: null })
    .where('status', '=', 'falhou')
    .where('created_at', '<', sql<Date>`now() - interval '7 days'`)
    .execute();
  // Linhas rejeitadas guardam dados crus da planilha: ficam 90 dias.
  await sql`DELETE FROM import_rejections r USING imports i
    WHERE i.id = r.import_id AND i.created_at < now() - interval '90 days'`.execute(db);
  await db.deleteFrom('audit_log').where('created_at', '<', sql<Date>`now() - interval '2 years'`).execute();
  await recoverStaleImports(db, 60);
}

export function startJobs(db: Db, log: FastifyBaseLogger): () => void {
  const run =
    (name: string, fn: () => Promise<unknown>, lock = JOB_LOCK) =>
    () => {
      exclusive(
        db,
        async () => {
          await fn();
        },
        lock,
      ).catch((err) => log.error({ err }, `tarefa ${name} falhou`));
    };
  const expire = run('expirar-leads', async () => {
    const n = await expireStaleLeads(db);
    if (n) log.info(`${n} leads parados voltaram para a fila livre`);
  });
  const clean = run('limpeza', () => cleanup(db));
  // Automações: UM job para todas (nada de timer por lead ou por etapa). Procura as participações vencidas
  // no PostgreSQL e atende um lote por ciclo. Sem Evolution configurada, o ciclo não faz nada.
  const automations = run(
    'automacoes',
    async () => {
      // Primeiro a fila das campanhas (reserva os próximos leads), depois o executor (envia o que venceu).
      const reserved = await advanceCampaigns(db);
      if (reserved.reserved || reserved.finished) {
        log.info(`campanhas: ${reserved.reserved} lead(s) reservado(s), ${reserved.finished} encerrada(s)`);
      }
      const r = await runAutomationCycle(db);
      // As telas abertas das campanhas que mudaram neste ciclo atualizam (uma vez por campanha, não uma por lead).
      await publishCampaignChange([...new Set([...reserved.campaignIds, ...r.campaignIds])]);
      if (r.claimed) {
        log.info(
          `automações: ${r.sent} enviada(s), ${r.skipped} pulada(s), ${r.cancelled} cancelada(s), ${r.failed} com falha, ${r.completed} concluída(s)`,
        );
      }
    },
    AUTOMATION_LOCK,
  );
  const t1 = setInterval(expire, 5 * 60_000);
  const t2 = setInterval(clean, 60 * 60_000);
  const t3 = setInterval(automations, CYCLE_SECONDS * 1000);
  setTimeout(expire, 20_000).unref();
  setTimeout(clean, 60_000).unref();
  setTimeout(automations, 15_000).unref();
  t1.unref();
  t2.unref();
  t3.unref();
  return () => {
    clearInterval(t1);
    clearInterval(t2);
    clearInterval(t3);
  };
}
