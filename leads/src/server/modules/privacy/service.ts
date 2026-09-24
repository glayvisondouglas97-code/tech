import { type Kysely, sql } from 'kysely';
import type { PrivacySearch } from '../../../shared/api';
import type { AuthUser } from '../../auth/sessions';
import type { Database } from '../../db/schema';
import { audit, maskPhone } from '../../lib/audit';
import { badRequest } from '../../lib/errors';
import { blockPhone } from '../blocklist/service';
import { displayPhone } from '../imports/phone';

type Db = Kysely<Database>;

/** Últimos 10 dígitos do número nacional: usados para achar o telefone em linhas rejeitadas (texto cru). */
function nationalTail(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}

export async function searchByPhone(
  db: Db,
  admin: AuthUser,
  phone: string,
  ip: string | null,
): Promise<PrivacySearch> {
  const leads = await db
    .selectFrom('leads as l')
    .innerJoin('lists as li', 'li.id', 'l.list_id')
    .select([
      'l.id',
      'l.name',
      'l.company',
      'l.status',
      'l.created_at',
      'l.called_at',
      'li.name as list_name',
      sql<number>`(SELECT count(*) FROM lead_events e WHERE e.lead_id = l.id)`.as('events'),
    ])
    .where('l.phone', '=', phone)
    .orderBy('l.id')
    .execute();
  const blocked = await db
    .selectFrom('blocked_phones')
    .select('phone')
    .where('phone', '=', phone)
    .executeTakeFirst();
  await audit(db, {
    userId: admin.id,
    action: 'consultou_titular',
    entity: 'telefone',
    entityId: maskPhone(phone),
    details: { leads: leads.length },
    ip,
  });
  return {
    phone,
    display: displayPhone(phone),
    blocked: !!blocked,
    leads: leads.map((l) => ({
      id: l.id,
      company: l.company,
      name: l.name,
      listName: l.list_name,
      status: l.status,
      createdAt: l.created_at.toISOString(),
      calledAt: l.called_at?.toISOString() ?? null,
      events: l.events,
    })),
  };
}

/** Relatório com todos os dados guardados sobre o número (direito de acesso, art. 18 da LGPD). */
export async function exportSubjectData(db: Db, admin: AuthUser, phone: string, ip: string | null) {
  const leads = await db
    .selectFrom('leads as l')
    .innerJoin('lists as li', 'li.id', 'l.list_id')
    .leftJoin('users as uc', 'uc.id', 'l.called_by')
    .select([
      'l.id',
      'l.name',
      'l.phone',
      'l.extra_phones',
      'l.extra',
      'l.status',
      'l.result',
      'l.note',
      'l.created_at',
      'l.called_at',
      'l.callback_at',
      'li.name as lista',
      'uc.name as chamado_por',
    ])
    .where('l.phone', '=', phone)
    .execute();
  const events = leads.length
    ? await db
        .selectFrom('lead_events as e')
        .leftJoin('users as u', 'u.id', 'e.user_id')
        .select(['e.lead_id', 'e.type', 'e.data', 'e.created_at', 'u.name as usuario'])
        .where(
          'e.lead_id',
          'in',
          leads.map((l) => l.id),
        )
        .orderBy('e.id')
        .execute()
    : [];
  const blocked = await db
    .selectFrom('blocked_phones')
    .selectAll()
    .where('phone', '=', phone)
    .executeTakeFirst();
  await audit(db, {
    userId: admin.id,
    action: 'exportou_dados_titular',
    entity: 'telefone',
    entityId: maskPhone(phone),
    details: { leads: leads.length },
    ip,
  });
  return {
    gerado_em: new Date().toISOString(),
    telefone: displayPhone(phone),
    lista_nao_contatar: blocked ? { desde: blocked.created_at, motivo: blocked.reason } : null,
    registros: leads.map((l) => ({
      ...l,
      historico: events.filter((e) => e.lead_id === l.id).map(({ lead_id: _, ...e }) => e),
    })),
  };
}

async function scrubRawCopies(trx: Db, phone: string) {
  const tail = nationalTail(phone);
  if (tail.length >= 8) {
    await sql`
      DELETE FROM import_rejections r
      WHERE EXISTS (SELECT 1 FROM unnest(r."values") v WHERE regexp_replace(v, '\\D', '', 'g') LIKE ${`%${tail}%`})`.execute(
      trx,
    );
  }
  await sql`DELETE FROM whatsapp_webhook_events WHERE payload::text LIKE ${`%${phone}%`}`.execute(trx);
}

/**
 * Anonimiza: apaga nome, telefone, colunas extras e observações, mas mantém os números agregados
 * (quantos foram chamados, por quem e quando). O lead some das filas.
 */
export async function anonymizeSubject(
  db: Db,
  admin: AuthUser,
  phone: string,
  opts: { block: boolean },
  ip: string | null,
): Promise<{ leads: number }> {
  return db.transaction().execute(async (trx) => {
    if (opts.block) await blockPhone(trx, admin, phone, 'Pedido do titular (LGPD)', ip);
    const rows = await sql<{ id: number }>`
      UPDATE leads SET name = 'Titular anonimizado', name_search = '', company = '', company_search = '',
        phone = '', extra_phones = '{}',
        extra = '{}', note = NULL, callback_at = NULL, assigned_to = NULL, assigned_at = NULL, assigned_via = NULL,
        status = CASE WHEN status = 'pendente' THEN 'bloqueado' ELSE status END,
        anonymized_at = now(), version = version + 1, updated_at = now()
      WHERE phone = ${phone}
      RETURNING id`.execute(trx);
    const ids = rows.rows.map((r) => r.id);
    if (ids.length) {
      await trx
        .updateTable('lead_events')
        .set({ data: '{}' })
        .where('lead_id', 'in', ids)
        .where('type', 'in', ['observacao', 'whatsapp_resposta', 'bloqueado'])
        .execute();
      await trx
        .insertInto('lead_events')
        .values(ids.map((id) => ({ lead_id: id, user_id: admin.id, type: 'anonimizado', data: '{}' })))
        .execute();
    }
    await scrubRawCopies(trx, phone);
    await audit(trx, {
      userId: admin.id,
      action: 'anonimizou_titular',
      entity: 'telefone',
      entityId: maskPhone(phone),
      details: { leads: ids.length, manteve_bloqueio: opts.block },
      ip,
    });
    return { leads: ids.length };
  });
}

/** Exclui de vez os leads com o número (e o histórico deles). */
export async function deleteSubject(
  db: Db,
  admin: AuthUser,
  phone: string,
  opts: { block: boolean },
  ip: string | null,
): Promise<{ leads: number }> {
  if (!phone) throw badRequest('Informe o telefone.');
  return db.transaction().execute(async (trx) => {
    const del = await trx.deleteFrom('leads').where('phone', '=', phone).executeTakeFirst();
    await scrubRawCopies(trx, phone);
    if (opts.block) {
      await trx
        .insertInto('blocked_phones')
        .values({ phone, reason: 'Pedido do titular (LGPD)', created_by: admin.id })
        .onConflict((oc) => oc.column('phone').doNothing())
        .execute();
    } else {
      await trx.deleteFrom('blocked_phones').where('phone', '=', phone).execute();
    }
    const n = Number(del.numDeletedRows);
    await audit(trx, {
      userId: admin.id,
      action: 'excluiu_titular',
      entity: 'telefone',
      entityId: maskPhone(phone),
      details: { leads: n, manteve_bloqueio: opts.block },
      ip,
    });
    return { leads: n };
  });
}
