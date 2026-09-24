/** Gravação de mensagens no banco: contato → conversa → mensagem, sem duplicar. */
import { type Kysely, sql } from 'kysely';
import type { Database, WaContact, WaConversation, WaInstance, WaMessage } from '../../db/schema';
import {
  contactJids,
  isNewerStatus,
  normalizeJid,
  parseContent,
  previewOf,
  type WaMessage as RawMessage,
  timestampToDate,
} from './parse';
import { publishConversation, publishConversationRemoved, publishInstance, publishMessage } from './realtime';

type Tx = Kysely<Database>;

export interface SaveOptions {
  /** true = mensagem nova (webhook ao vivo); false = importação de histórico (não mexe nas não lidas). */
  live: boolean;
  /** Quando já sabemos a conversa (envio pelo sistema), pula a identificação do contato. */
  conversationId?: number;
}

export interface SavedMessage {
  message: WaMessage;
  conversation: WaConversation;
}

/** O que mudou ao juntar contatos duplicados (telefone ↔ @lid), para avisar os navegadores depois de gravar. */
interface MergeChanges {
  removed: { id: number; mergedInto: number; instanceId: number }[];
  touched: Set<number>;
}

/** Cria ou atualiza o número. Avisa a tela quando o status ou o telefone mudam. */
export async function upsertInstance(
  db: Kysely<Database>,
  name: string,
  data: { status?: string; phoneJid?: string | null } = {},
): Promise<WaInstance> {
  const phoneJid = data.phoneJid ? normalizeJid(data.phoneJid) : undefined;
  const existing = await db
    .selectFrom('wa_instances')
    .selectAll()
    .where('name', '=', name)
    .executeTakeFirst();
  if (
    existing &&
    (data.status ?? existing.status) === existing.status &&
    (phoneJid ?? existing.phone_jid) === existing.phone_jid
  ) {
    return existing;
  }
  const instance = existing
    ? await db
        .updateTable('wa_instances')
        .set({
          status: data.status ?? existing.status,
          phone_jid: phoneJid ?? existing.phone_jid,
          updated_at: sql`now()`,
        })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow()
    : await db
        .insertInto('wa_instances')
        .values({ name, status: data.status ?? 'close', phone_jid: phoneJid ?? null })
        .returningAll()
        .executeTakeFirstOrThrow();
  await publishInstance(instance.id);
  return instance;
}

/** Salva uma mensagem. Retorna null se ela for ignorada (grupo, status, tipo sem conteúdo) ou se já existia. */
export async function saveMessage(
  db: Kysely<Database>,
  instanceName: string,
  msg: RawMessage,
  options: SaveOptions,
): Promise<SavedMessage | null> {
  if (!msg?.key?.id || !msg.key.remoteJid) return null;
  const jids = contactJids(msg.key);
  if (!jids.phoneJid && !jids.lidJid) return null; // grupo, status (stories) ou canal
  const content = parseContent(msg);
  if (!content) return null;

  const instance = await upsertInstance(db, instanceName);
  if (instance.phone_jid && jids.phoneJid === instance.phone_jid) return null; // conversa consigo mesmo

  const sentAt = timestampToDate(msg.messageTimestamp);
  const fromMe = !!msg.key.fromMe;
  const leadName = !fromMe && msg.pushName?.trim() ? msg.pushName.trim() : null;
  const waId = msg.key.id;

  const changes: MergeChanges = { removed: [], touched: new Set() };
  const { saved, statusUpdated } = await db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom('wa_messages')
      .selectAll()
      .where('instance_id', '=', instance.id)
      .where('wa_id', '=', waId)
      .executeTakeFirst();
    if (existing) {
      // Mensagem repetida: não grava de novo, mas aproveita para aprender a relação telefone ↔ @lid.
      if (jids.phoneJid && jids.lidJid)
        await resolveContact(tx, jids.phoneJid, jids.lidJid, leadName, changes);
      const statusUpdated = isNewerStatus(existing.status, msg.status)
        ? await tx
            .updateTable('wa_messages')
            .set({ status: msg.status ?? null })
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : null;
      return { saved: null, statusUpdated };
    }

    let conversation: WaConversation;
    if (options.conversationId) {
      conversation = await tx
        .selectFrom('wa_conversations')
        .selectAll()
        .where('id', '=', options.conversationId)
        .executeTakeFirstOrThrow();
    } else {
      const contact = await resolveContact(tx, jids.phoneJid, jids.lidJid, leadName, changes);
      conversation =
        (await tx
          .selectFrom('wa_conversations')
          .selectAll()
          .where('instance_id', '=', instance.id)
          .where('contact_id', '=', contact.id)
          .executeTakeFirst()) ??
        (await tx
          .insertInto('wa_conversations')
          .values({ instance_id: instance.id, contact_id: contact.id, last_message_at: sentAt })
          .returningAll()
          .executeTakeFirstOrThrow());
    }

    const message = await tx
      .insertInto('wa_messages')
      .values({
        instance_id: instance.id,
        conversation_id: conversation.id,
        wa_id: waId,
        remote_jid: normalizeJid(msg.key.remoteJid),
        from_me: fromMe,
        type: content.type,
        text: content.text,
        file_name: content.fileName,
        media_mime: content.mimetype,
        status: msg.status ?? null,
        sent_at: sentAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const isLatest = !conversation.last_message_at || sentAt >= conversation.last_message_at;
    const updated = await tx
      .updateTable('wa_conversations')
      .set((eb) => ({
        ...(isLatest && {
          last_message_at: sentAt,
          last_message_preview: previewOf(content),
          last_message_from_me: fromMe,
        }),
        ...(!fromMe && { lead_replied: true }),
        // Ao vivo: mensagem do contato soma nas não lidas; resposta nossa (sistema ou celular) zera.
        ...(options.live && { unread_count: fromMe ? 0 : eb('unread_count', '+', 1) }),
      }))
      .where('id', '=', conversation.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return { saved: { message, conversation: updated }, statusUpdated: null };
  });

  // Histórico importado não gera um aviso por mensagem: no fim, a importação pede para a tela recarregar.
  if (options.live) await publishSaveResult(changes, saved, statusUpdated);
  return saved;
}

async function publishSaveResult(
  changes: MergeChanges,
  saved: SavedMessage | null,
  statusUpdated: WaMessage | null,
) {
  for (const { id, mergedInto, instanceId } of changes.removed)
    await publishConversationRemoved(id, mergedInto, instanceId);
  if (statusUpdated) await publishMessage('message:updated', statusUpdated);
  if (saved) {
    await publishMessage('message:new', saved.message);
    changes.touched.add(saved.conversation.id);
  }
  for (const id of changes.touched) await publishConversation(id);
}

/**
 * Conversa de um número com um lead, aberta pelo botão "Chamar" (pode ainda não ter mensagens).
 * Usa o contato que já existir (pelo telefone ou @lid) e liga a conversa ao lead.
 */
export async function openLeadConversation(
  db: Kysely<Database>,
  instanceId: number,
  jids: { phoneJid: string | null; lidJid: string | null },
  leadId: number,
): Promise<WaConversation> {
  const changes: MergeChanges = { removed: [], touched: new Set() };
  const conversation = await db.transaction().execute(async (tx) => {
    const contact = await resolveContact(tx, jids.phoneJid, jids.lidJid, null, changes);
    const existing = await tx
      .selectFrom('wa_conversations')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .where('contact_id', '=', contact.id)
      .executeTakeFirst();
    if (existing) {
      return existing.lead_id === leadId
        ? existing
        : tx
            .updateTable('wa_conversations')
            .set({ lead_id: leadId })
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow();
    }
    return tx
      .insertInto('wa_conversations')
      .values({ instance_id: instanceId, contact_id: contact.id, lead_id: leadId })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
  changes.touched.add(conversation.id);
  await publishSaveResult(changes, null, null);
  return conversation;
}

/**
 * Encontra (ou cria) o contato pelo telefone e/ou @lid. Se a mesma pessoa estiver em dois contatos
 * (um só com telefone e outro só com @lid), junta os dois num só.
 */
async function resolveContact(
  tx: Tx,
  phoneJid: string | null,
  lidJid: string | null,
  name: string | null,
  changes: MergeChanges,
): Promise<WaContact> {
  const matches = await tx
    .selectFrom('wa_contacts')
    .selectAll()
    .where((eb) =>
      eb.or([
        ...(phoneJid ? [eb('phone_jid', '=', phoneJid)] : []),
        ...(lidJid ? [eb('lid_jid', '=', lidJid)] : []),
      ]),
    )
    .orderBy('id')
    .execute();

  if (matches.length === 0) {
    return tx
      .insertInto('wa_contacts')
      .values({ phone_jid: phoneJid, lid_jid: lidJid, name })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  // Fica o contato que tem telefone (ou o mais antigo); os outros são incorporados a ele.
  const [keep, ...others] = [...matches].sort(
    (a, b) => Number(!a.phone_jid) - Number(!b.phone_jid) || a.id - b.id,
  ) as [WaContact, ...WaContact[]];
  for (const other of others) {
    await mergeContact(tx, keep, other, changes);
  }

  const data = {
    phone_jid: keep.phone_jid ?? phoneJid ?? others.find((o) => o.phone_jid)?.phone_jid ?? null,
    lid_jid: keep.lid_jid ?? lidJid ?? others.find((o) => o.lid_jid)?.lid_jid ?? null,
    name: name ?? keep.name ?? others.find((o) => o.name)?.name ?? null,
  };
  const changed =
    data.phone_jid !== keep.phone_jid || data.lid_jid !== keep.lid_jid || data.name !== keep.name;
  return changed
    ? tx
        .updateTable('wa_contacts')
        .set({ ...data, updated_at: sql`now()` })
        .where('id', '=', keep.id)
        .returningAll()
        .executeTakeFirstOrThrow()
    : keep;
}

/** Move as conversas e mensagens de "other" para "keep" e apaga "other". */
async function mergeContact(tx: Tx, keep: WaContact, other: WaContact, changes: MergeChanges): Promise<void> {
  const conversations = await tx
    .selectFrom('wa_conversations')
    .selectAll()
    .where('contact_id', '=', other.id)
    .execute();
  for (const conversation of conversations) {
    const target = await tx
      .selectFrom('wa_conversations')
      .selectAll()
      .where('instance_id', '=', conversation.instance_id)
      .where('contact_id', '=', keep.id)
      .executeTakeFirst();
    if (!target) {
      await tx
        .updateTable('wa_conversations')
        .set({ contact_id: keep.id })
        .where('id', '=', conversation.id)
        .execute();
      changes.touched.add(conversation.id);
      continue;
    }
    await tx
      .updateTable('wa_messages')
      .set({ conversation_id: target.id })
      .where('conversation_id', '=', conversation.id)
      .execute();
    const otherIsLatest =
      !!conversation.last_message_at &&
      (!target.last_message_at || conversation.last_message_at > target.last_message_at);
    await tx
      .updateTable('wa_conversations')
      .set({
        unread_count: target.unread_count + conversation.unread_count,
        lead_replied: target.lead_replied || conversation.lead_replied,
        lead_id: target.lead_id ?? conversation.lead_id,
        ...(otherIsLatest && {
          last_message_at: conversation.last_message_at,
          last_message_preview: conversation.last_message_preview,
          last_message_from_me: conversation.last_message_from_me,
        }),
      })
      .where('id', '=', target.id)
      .execute();
    await tx.deleteFrom('wa_conversations').where('id', '=', conversation.id).execute();
    changes.removed.push({
      id: conversation.id,
      mergedInto: target.id,
      instanceId: conversation.instance_id,
    });
    changes.touched.delete(conversation.id);
    changes.touched.add(target.id);
  }
  await tx.deleteFrom('wa_contacts').where('id', '=', other.id).execute();
}

/** Atualiza o status (entregue, lida…) de uma mensagem já salva. */
export async function updateMessageStatus(
  db: Kysely<Database>,
  instanceName: string,
  waId: string,
  status: string,
): Promise<WaMessage | null> {
  const message = await db
    .selectFrom('wa_messages as m')
    .innerJoin('wa_instances as i', 'i.id', 'm.instance_id')
    .selectAll('m')
    .where('i.name', '=', instanceName)
    .where('m.wa_id', '=', waId)
    .executeTakeFirst();
  if (!message || !isNewerStatus(message.status, status)) return null;
  const updated = await db
    .updateTable('wa_messages')
    .set({ status })
    .where('id', '=', message.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await publishMessage('message:updated', updated);
  return updated;
}
