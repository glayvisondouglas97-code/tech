/** Formato dos dados enviados ao navegador (pela API e pelo tempo real). */
import type { Kysely } from 'kysely';
import type {
  ChatMessage,
  ChatMessageType,
  ConversationItem,
  InstanceInfo,
} from '../../../shared/conversations';
import type { Database, WaInstance, WaMessage } from '../../db/schema';

const phoneOf = (jid: string | null) => (jid ? (jid.split('@')[0] ?? null) : null);
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** Nome do lead como aparece no Chamador: a empresa ou, sem empresa, o sócio. */
const leadLabel = (company: string | null, name: string | null) => company || name || 'Lead sem nome';

/** Números com o nome do responsável. */
export function instancesQuery(db: Kysely<Database>) {
  return db
    .selectFrom('wa_instances as i')
    .leftJoin('users as u', 'u.id', 'i.owner_id')
    .selectAll('i')
    .select('u.name as owner_name');
}

export function instanceDto(i: WaInstance & { owner_name?: string | null }): InstanceInfo {
  return {
    id: i.id,
    name: i.name,
    nickname: i.nickname,
    phone: phoneOf(i.phone_jid),
    status: i.status,
    owner: i.owner_id ? { id: i.owner_id, name: i.owner_name ?? 'Usuário removido' } : null,
  };
}

/** Conversa com o contato e o número (usada na lista, no chat e no tempo real). */
export function conversationsQuery(db: Kysely<Database>) {
  return db
    .selectFrom('wa_conversations as c')
    .innerJoin('wa_contacts as ct', 'ct.id', 'c.contact_id')
    .innerJoin('wa_instances as i', 'i.id', 'c.instance_id')
    .leftJoin('leads as l', 'l.id', 'c.lead_id')
    .select([
      'c.id',
      'c.unread_count',
      'c.lead_replied',
      'c.last_message_at',
      'c.last_message_preview',
      'c.last_message_from_me',
      'ct.id as contact_id',
      'ct.name as contact_name',
      'ct.phone_jid as contact_phone_jid',
      'i.id as instance_id',
      'i.name as instance_name',
      'i.nickname as instance_nickname',
      'i.status as instance_status',
      'i.owner_id as instance_owner_id',
      'c.lead_id',
      'l.company as lead_company',
      'l.name as lead_name',
    ]);
}

export type ConversationRow = Awaited<
  ReturnType<ReturnType<typeof conversationsQuery>['executeTakeFirstOrThrow']>
>;

export function conversationDto(c: ConversationRow): ConversationItem {
  return {
    id: c.id,
    unreadCount: c.unread_count,
    leadReplied: c.lead_replied,
    lastMessageAt: c.last_message_at ? iso(c.last_message_at) : null,
    lastMessagePreview: c.last_message_preview,
    lastMessageFromMe: c.last_message_from_me,
    contact: { id: c.contact_id, name: c.contact_name, phone: phoneOf(c.contact_phone_jid) },
    instance: {
      id: c.instance_id,
      name: c.instance_name,
      nickname: c.instance_nickname,
      status: c.instance_status,
    },
    lead: c.lead_id ? { id: c.lead_id, label: leadLabel(c.lead_company, c.lead_name) } : null,
  };
}

export function messageDto(m: WaMessage): ChatMessage {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    waId: m.wa_id,
    fromMe: m.from_me,
    type: m.type as ChatMessageType,
    text: m.text,
    fileName: m.file_name,
    mediaMime: m.media_mime,
    status: m.status,
    sentAt: iso(m.sent_at),
    sentById: m.sent_by,
  };
}
