import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../db';
import { recoverStaleImports } from '../modules/imports/service';
import { releaseLeads } from '../modules/leads/service';
import { getSettings } from '../modules/settings/service';

const JOB_LOCK = 720_002;

/** Roda a tarefa só em um servidor por vez (se houver mais de um). */
async function exclusive(db: Db, fn: () => Promise<void>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const r = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(${JOB_LOCK}) AS ok`.execute(trx);
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
  await db
    .deleteFrom('whatsapp_webhook_events')
    .where('received_at', '<', sql<Date>`now() - interval '30 days'`)
    .execute();
  await db.deleteFrom('audit_log').where('created_at', '<', sql<Date>`now() - interval '2 years'`).execute();
  await recoverStaleImports(db, 60);
}

export function startJobs(db: Db, log: FastifyBaseLogger): () => void {
  const run = (name: string, fn: () => Promise<unknown>) => () => {
    exclusive(db, async () => {
      await fn();
    }).catch((err) => log.error({ err }, `tarefa ${name} falhou`));
  };
  const expire = run('expirar-leads', async () => {
    const n = await expireStaleLeads(db);
    if (n) log.info(`${n} leads parados voltaram para a fila livre`);
  });
  const clean = run('limpeza', () => cleanup(db));
  const t1 = setInterval(expire, 5 * 60_000);
  const t2 = setInterval(clean, 60 * 60_000);
  setTimeout(expire, 20_000).unref();
  setTimeout(clean, 60_000).unref();
  t1.unref();
  t2.unref();
  return () => {
    clearInterval(t1);
    clearInterval(t2);
  };
}
