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

export function instanceDto(i: WaInstance): InstanceInfo {
  return { id: i.id, name: i.name, nickname: i.nickname, phone: phoneOf(i.phone_jid), status: i.status };
}

/** Conversa com o contato e o número (usada na lista, no chat e no tempo real). */
export function conversationsQuery(db: Kysely<Database>) {
  return db
    .selectFrom('wa_conversations as c')
    .innerJoin('wa_contacts as ct', 'ct.id', 'c.contact_id')
    .innerJoin('wa_instances as i', 'i.id', 'c.instance_id')
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
    lastMessageAt: iso(c.last_message_at),
    lastMessagePreview: c.last_message_preview,
    lastMessageFromMe: c.last_message_from_me,
    contact: { id: c.contact_id, name: c.contact_name, phone: phoneOf(c.contact_phone_jid) },
    instance: {
      id: c.instance_id,
      name: c.instance_name,
      nickname: c.instance_nickname,
      status: c.instance_status,
    },
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
