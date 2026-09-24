// Formato dos dados enviados ao navegador (pela API e pelo tempo real).
import type { Contact, Conversation, Instance, Message } from './generated/prisma/client.ts';

const phoneOf = (jid: string | null) => (jid ? jid.split('@')[0] : null);

export function instanceDto(i: Instance) {
  return { id: i.id, name: i.name, nickname: i.nickname, phone: phoneOf(i.phoneJid), status: i.status };
}

export function conversationDto(c: Conversation & { contact: Contact; instance: Instance }) {
  return {
    id: c.id,
    unreadCount: c.unreadCount,
    leadReplied: c.leadReplied,
    lastMessageAt: c.lastMessageAt,
    lastMessagePreview: c.lastMessagePreview,
    lastMessageFromMe: c.lastMessageFromMe,
    contact: { id: c.contact.id, name: c.contact.name, phone: phoneOf(c.contact.phoneJid) },
    instance: { id: c.instance.id, name: c.instance.name, nickname: c.instance.nickname, status: c.instance.status },
  };
}

export function messageDto(m: Message) {
  const { instanceId, remoteJid, ...rest } = m;
  return rest;
}
