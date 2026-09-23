// Gravação de mensagens no banco: contato → conversa → mensagem, sem duplicar.
import { prisma } from './db.ts';
import type { Contact, Conversation, Instance, Message, Prisma } from './generated/prisma/client.ts';
import {
  contactJids,
  isNewerStatus,
  normalizeJid,
  parseContent,
  previewOf,
  timestampToDate,
  type WaMessage,
} from './whatsapp.ts';

type Tx = Prisma.TransactionClient;

export type SaveOptions = {
  // true = mensagem nova (webhook ao vivo); false = importação de histórico (não mexe nas não lidas).
  live: boolean;
  // Quando já sabemos a conversa (envio pelo sistema), pula a identificação do contato.
  conversationId?: number;
};

export type SavedMessage = { message: Message; conversation: Conversation };

export async function upsertInstance(name: string, data: { status?: string; phoneJid?: string | null } = {}): Promise<Instance> {
  const phoneJid = data.phoneJid ? normalizeJid(data.phoneJid) : undefined;
  return prisma.instance.upsert({
    where: { name },
    create: { name, status: data.status ?? 'close', phoneJid },
    update: { status: data.status, phoneJid },
  });
}

// Salva uma mensagem. Retorna null se ela for ignorada (grupo, status, tipo sem conteúdo) ou se já existia.
export async function saveMessage(instanceName: string, msg: WaMessage, options: SaveOptions): Promise<SavedMessage | null> {
  if (!msg?.key?.id || !msg.key.remoteJid) return null;
  const jids = contactJids(msg.key);
  if (!jids.phoneJid && !jids.lidJid) return null; // grupo, status (stories) ou canal
  const content = parseContent(msg);
  if (!content) return null;

  const instance = (await prisma.instance.findUnique({ where: { name: instanceName } })) ?? (await upsertInstance(instanceName));
  if (instance.phoneJid && jids.phoneJid === instance.phoneJid) return null; // conversa consigo mesmo

  const sentAt = timestampToDate(msg.messageTimestamp);
  const fromMe = !!msg.key.fromMe;
  const leadName = !fromMe && msg.pushName?.trim() ? msg.pushName.trim() : null;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.message.findUnique({
      where: { instanceId_waId: { instanceId: instance.id, waId: msg.key.id } },
    });
    if (existing) {
      // Mensagem repetida: não grava de novo, mas aproveita para aprender a relação telefone ↔ @lid.
      if (jids.phoneJid && jids.lidJid) await resolveContact(tx, jids.phoneJid, jids.lidJid, leadName);
      if (isNewerStatus(existing.status, msg.status)) {
        await tx.message.update({ where: { id: existing.id }, data: { status: msg.status } });
      }
      return null;
    }

    let conversation: Conversation;
    if (options.conversationId) {
      conversation = await tx.conversation.findUniqueOrThrow({ where: { id: options.conversationId } });
    } else {
      const contact = await resolveContact(tx, jids.phoneJid, jids.lidJid, leadName);
      conversation = await tx.conversation.upsert({
        where: { instanceId_contactId: { instanceId: instance.id, contactId: contact.id } },
        create: { instanceId: instance.id, contactId: contact.id, lastMessageAt: sentAt },
        update: {},
      });
    }

    const message = await tx.message.create({
      data: {
        instanceId: instance.id,
        conversationId: conversation.id,
        waId: msg.key.id,
        remoteJid: normalizeJid(msg.key.remoteJid),
        fromMe,
        type: content.type,
        text: content.text,
        fileName: content.fileName,
        status: msg.status ?? null,
        sentAt,
      },
    });

    const isLatest = sentAt >= conversation.lastMessageAt;
    const updated = await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        ...(isLatest && { lastMessageAt: sentAt, lastMessagePreview: previewOf(content), lastMessageFromMe: fromMe }),
        ...(!fromMe && { leadReplied: true }),
        // Ao vivo: mensagem do lead soma nas não lidas; resposta nossa (sistema ou celular) zera.
        ...(options.live && (fromMe ? { unreadCount: 0 } : { unreadCount: { increment: 1 } })),
      },
    });

    return { message, conversation: updated };
  });
}

// Encontra (ou cria) o contato pelo telefone e/ou @lid. Se a mesma pessoa estiver em dois contatos
// (um só com telefone e outro só com @lid), junta os dois num só.
async function resolveContact(tx: Tx, phoneJid: string | null, lidJid: string | null, name: string | null): Promise<Contact> {
  const or: Prisma.ContactWhereInput[] = [];
  if (phoneJid) or.push({ phoneJid });
  if (lidJid) or.push({ lidJid });
  const matches = await tx.contact.findMany({ where: { OR: or }, orderBy: { id: 'asc' } });

  if (matches.length === 0) {
    return tx.contact.create({ data: { phoneJid, lidJid, name } });
  }

  // Fica o contato que tem telefone (ou o mais antigo); os outros são incorporados a ele.
  const [keep, ...others] = [...matches].sort((a, b) => Number(!a.phoneJid) - Number(!b.phoneJid) || a.id - b.id);
  for (const other of others) {
    await mergeContact(tx, keep, other);
  }

  const data = {
    phoneJid: keep.phoneJid ?? phoneJid ?? others.find((o) => o.phoneJid)?.phoneJid ?? null,
    lidJid: keep.lidJid ?? lidJid ?? others.find((o) => o.lidJid)?.lidJid ?? null,
    name: name ?? keep.name ?? others.find((o) => o.name)?.name ?? null,
  };
  const changed = data.phoneJid !== keep.phoneJid || data.lidJid !== keep.lidJid || data.name !== keep.name;
  return changed ? tx.contact.update({ where: { id: keep.id }, data }) : keep;
}

// Move as conversas e mensagens de "other" para "keep" e apaga "other".
async function mergeContact(tx: Tx, keep: Contact, other: Contact): Promise<void> {
  const conversations = await tx.conversation.findMany({ where: { contactId: other.id } });
  for (const conversation of conversations) {
    const target = await tx.conversation.findUnique({
      where: { instanceId_contactId: { instanceId: conversation.instanceId, contactId: keep.id } },
    });
    if (!target) {
      await tx.conversation.update({ where: { id: conversation.id }, data: { contactId: keep.id } });
      continue;
    }
    await tx.message.updateMany({ where: { conversationId: conversation.id }, data: { conversationId: target.id } });
    const otherIsLatest = conversation.lastMessageAt > target.lastMessageAt;
    await tx.conversation.update({
      where: { id: target.id },
      data: {
        unreadCount: target.unreadCount + conversation.unreadCount,
        leadReplied: target.leadReplied || conversation.leadReplied,
        ...(otherIsLatest && {
          lastMessageAt: conversation.lastMessageAt,
          lastMessagePreview: conversation.lastMessagePreview,
          lastMessageFromMe: conversation.lastMessageFromMe,
        }),
      },
    });
    await tx.conversation.delete({ where: { id: conversation.id } });
  }
  await tx.contact.delete({ where: { id: other.id } });
}

// Atualiza o status (entregue, lida…) de uma mensagem já salva.
export async function updateMessageStatus(instanceName: string, waId: string, status: string): Promise<Message | null> {
  const instance = await prisma.instance.findUnique({ where: { name: instanceName } });
  if (!instance) return null;
  const message = await prisma.message.findUnique({ where: { instanceId_waId: { instanceId: instance.id, waId } } });
  if (!message || !isNewerStatus(message.status, status)) return null;
  return prisma.message.update({ where: { id: message.id }, data: { status } });
}
