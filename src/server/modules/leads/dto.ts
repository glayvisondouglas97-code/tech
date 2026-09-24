import { type Kysely, sql } from 'kysely';
import type { LeadItem } from '../../../shared/api';
import { can } from '../../../shared/roles';
import type { AuthUser } from '../../auth/sessions';
import type { Database } from '../../db/schema';
import { displayPhone } from '../imports/phone';

/** Consulta base de leads com lista e nomes de quem está com o lead e de quem chamou. */
export function selectLeads(db: Kysely<Database>) {
  return db
    .selectFrom('leads as l')
    .innerJoin('lists as li', 'li.id', 'l.list_id')
    .leftJoin('users as ua', 'ua.id', 'l.assigned_to')
    .leftJoin('users as uc', 'uc.id', 'l.called_by')
    .select([
      'l.id',
      'l.version',
      'l.name',
      'l.company',
      'l.ddd',
      'l.phone',
      'l.phone_type',
      'l.extra_phones',
      'l.extra',
      'l.status',
      'l.assigned_to',
      'l.assigned_at',
      'l.whatsapp_opened_at',
      'l.called_by',
      'l.called_at',
      'l.result',
      'l.note',
      'l.callback_at',
      'l.anonymized_at',
      'l.row_number',
      'li.id as list_id',
      'li.name as list_name',
      'li.archived_at as list_archived_at',
      'ua.name as assigned_name',
      'uc.name as called_name',
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof selectLeads>['executeTakeFirstOrThrow']>>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toLeadItem(r: Row): LeadItem {
  const anonymized = !!r.anonymized_at;
  return {
    id: r.id,
    version: r.version,
    company: r.company,
    name: r.name,
    phone: anonymized ? '' : r.phone,
    ddd: r.ddd,
    phoneDisplay: anonymized ? 'Anonimizado' : displayPhone(r.phone),
    phoneType: r.phone_type,
    extraPhones: (r.extra_phones ?? []).map((p) => ({ phone: p, display: displayPhone(p) })),
    extra: r.extra ?? {},
    list: { id: r.list_id, name: r.list_name, archived: !!r.list_archived_at },
    status: r.status,
    assignedTo: r.assigned_to ? { id: r.assigned_to, name: r.assigned_name ?? 'Usuário removido' } : null,
    assignedAt: iso(r.assigned_at),
    whatsappOpenedAt: iso(r.whatsapp_opened_at),
    calledBy: r.called_by ? { id: r.called_by, name: r.called_name ?? 'Usuário removido' } : null,
    calledAt: iso(r.called_at),
    result: r.result,
    note: r.note,
    callbackAt: iso(r.callback_at),
    anonymized,
  };
}

/**
 * Regra de visibilidade aplicada em toda consulta de leads (o lead sempre com o apelido "l"):
 * gestor e supervisor veem tudo; o atendente vê só os leads na fila dele e os que ele chamou.
 */
export function visibleTo(user: AuthUser) {
  if (can.seeAllLeads(user.role)) return sql<boolean>`true`;
  return sql<boolean>`((l.status = 'pendente' AND l.assigned_to = ${user.id}) OR l.called_by = ${user.id})`;
}

/** Mesma regra, para conferir um lead já carregado. */
export function canSee(
  user: AuthUser,
  lead: { status: string; assigned_to: string | null; called_by: string | null },
): boolean {
  if (can.seeAllLeads(user.role)) return true;
  return (lead.status === 'pendente' && lead.assigned_to === user.id) || lead.called_by === user.id;
}
