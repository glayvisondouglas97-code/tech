import { type Kysely, sql } from 'kysely';
import type { BlockedPhone, Page } from '../../../shared/api';
import type { AuthUser } from '../../auth/sessions';
import type { Database } from '../../db/schema';
import { audit, maskPhone } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { addEvents } from '../../lib/events';
import { cancelRunsForBlockedLeads } from '../automations/runs';
import { displayPhone, normalizePhones } from '../imports/phone';

type Db = Kysely<Database>;

export function parsePhoneOrThrow(raw: string, defaultDdd: string | null): string {
  const r = normalizePhones(raw, defaultDdd);
  const p = r.phones[0];
  if (!p) {
    throw badRequest(
      r.error === 'sem_ddd'
        ? 'Informe o telefone com DDD.'
        : 'Telefone inválido. Use o formato (41) 99876-5432.',
    );
  }
  return p.e164;
}

/**
 * Coloca o número na lista de não contatar e tira da fila todos os leads com ele.
 * Leads já chamados continuam contando nas métricas (a data e o resultado ficam guardados).
 */
export async function blockPhone(
  db: Db,
  user: AuthUser | null,
  phone: string,
  reason: string | null,
  ip?: string | null,
): Promise<number> {
  await db
    .insertInto('blocked_phones')
    .values({ phone, reason: reason?.slice(0, 200) || null, created_by: user?.id ?? null })
    .onConflict((oc) => oc.column('phone').doNothing())
    .execute();
  const affected = await sql<{ id: number }>`
    UPDATE leads SET status = 'bloqueado', assigned_to = NULL, assigned_at = NULL, assigned_via = NULL,
      callback_at = NULL, version = version + 1, updated_at = now()
    WHERE phone = ${phone} AND status <> 'bloqueado'
    RETURNING id`.execute(db);
  await addEvents(
    db,
    affected.rows.map((r) => ({
      leadId: r.id,
      userId: user?.id ?? null,
      type: 'bloqueado',
      data: { motivo: reason || 'Pediu para não ser contatado' },
    })),
  );
  // Automações: lead em "não contatar" não recebe mais nada, mesmo com uma sequência em andamento.
  await cancelRunsForBlockedLeads(
    db,
    affected.rows.map((r) => r.id),
  );
  await audit(db, {
    userId: user?.id ?? null,
    action: 'bloqueou_numero',
    entity: 'telefone',
    entityId: maskPhone(phone),
    details: { leads: affected.rows.length },
    ip,
  });
  return affected.rows.length;
}

/** Tira da lista de não contatar. Leads não chamados voltam para a fila livre. */
export async function unblockPhone(
  db: Db,
  user: AuthUser,
  phone: string,
  ip?: string | null,
): Promise<number> {
  const del = await db.deleteFrom('blocked_phones').where('phone', '=', phone).executeTakeFirst();
  if (!Number(del.numDeletedRows)) throw notFound('Esse número não está na lista de não contatar.');
  const affected = await sql<{ id: number }>`
    UPDATE leads SET status = CASE WHEN called_at IS NULL THEN 'pendente' ELSE 'chamado' END,
      version = version + 1, updated_at = now()
    WHERE phone = ${phone} AND status = 'bloqueado' AND anonymized_at IS NULL
    RETURNING id`.execute(db);
  await addEvents(
    db,
    affected.rows.map((r) => ({ leadId: r.id, userId: user.id, type: 'desbloqueado' })),
  );
  await audit(db, {
    userId: user.id,
    action: 'desbloqueou_numero',
    entity: 'telefone',
    entityId: maskPhone(phone),
    details: { leads: affected.rows.length },
    ip,
  });
  return affected.rows.length;
}

export async function listBlocked(
  db: Db,
  opts: { q?: string; page: number; pageSize: number },
): Promise<Page<BlockedPhone>> {
  let base = db.selectFrom('blocked_phones as b');
  const digits = (opts.q ?? '').replace(/\D/g, '');
  if (digits.length >= 3) base = base.where('b.phone', 'like', `%${digits}%`);
  const [{ n }] = (await base.select(sql<number>`count(*)`.as('n')).execute()) as [{ n: number }];
  const rows = await base
    .leftJoin('users as u', 'u.id', 'b.created_by')
    .select(['b.phone', 'b.reason', 'b.created_at', 'b.created_by', 'u.name as user_name'])
    .orderBy('b.created_at', 'desc')
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize)
    .execute();
  return {
    items: rows.map((r) => ({
      phone: r.phone,
      display: displayPhone(r.phone),
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
      createdBy: r.created_by ? { id: r.created_by, name: r.user_name ?? '' } : null,
    })),
    total: n,
    page: opts.page,
    pageSize: opts.pageSize,
  };
}
