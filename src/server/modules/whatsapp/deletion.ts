/**
 * Excluir mensagens, conversas e números. Quem pode: o responsável pelo número ou dono/administrador.
 * O que sai do sistema não volta: o ID de cada mensagem apagada fica guardado (wa_deleted_messages),
 * e a importação de histórico e os webhooks repetidos pulam essas mensagens.
 */
import { sql } from 'kysely';
import type { AuthUser } from '../../auth/sessions';
import type { Db } from '../../db';
import { audit } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { canManageNumber, canSeeNumber, manageableNumber } from './access';
import { EvolutionError, evolution } from './evolution';
import { markInstanceDeleted, unmarkInstanceDeleted } from './instances';
import { removeMediaFiles } from './media';
import { ensureConnected, evolutionFailure } from './messaging';
import { type MessageType, previewOf } from './parse';
import { enqueue } from './queue';
import {
  publishConversation,
  publishConversationDeleted,
  publishInstanceDeleted,
  publishMessagesDeleted,
} from './realtime';

/** O WhatsApp só deixa apagar para todos as mensagens enviadas há pouco (cerca de 2 dias). */
export const FOR_EVERYONE_LIMIT_MS = 48 * 60 * 60 * 1000;

const NO_PERMISSION = 'Só o responsável pelo número ou um administrador pode apagar.';

/** Tira as mensagens do banco guardando o ID de cada uma. Devolve os arquivos de mídia a remover. */
async function purgeMessages(tx: Db, messageIds: number[]): Promise<string[]> {
  if (!messageIds.length) return [];
  await sql`
    INSERT INTO wa_deleted_messages (instance_id, wa_id)
    SELECT instance_id, wa_id FROM wa_messages WHERE id IN (${sql.join(messageIds)})
    ON CONFLICT DO NOTHING`.execute(tx);
  const removed = await tx
    .deleteFrom('wa_messages')
    .where('id', 'in', messageIds)
    .returning('media_path')
    .execute();
  return removed.map((m) => m.media_path).filter((p): p is string => !!p);
}

/** Depois de apagar mensagens: última mensagem, prévia e não lidas da conversa voltam a bater. */
async function refreshConversation(tx: Db, conversationId: number): Promise<void> {
  const latest = await tx
    .selectFrom('wa_messages')
    .select(['sent_at', 'from_me', 'type', 'text', 'file_name', 'media_mime'])
    .where('conversation_id', '=', conversationId)
    .orderBy('sent_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  await tx
    .updateTable('wa_conversations')
    .set({
      last_message_at: latest?.sent_at ?? null,
      last_message_preview: latest
        ? previewOf({
            type: latest.type as MessageType,
            text: latest.text,
            fileName: latest.file_name,
            mimetype: latest.media_mime,
          })
        : null,
      last_message_from_me: latest?.from_me ?? false,
      // Não lidas: no máximo as mensagens do contato que sobraram depois da última resposta.
      unread_count: sql<number>`LEAST(unread_count, (
        SELECT count(*) FROM wa_messages m
        WHERE m.conversation_id = ${conversationId} AND NOT m.from_me
          AND m.sent_at > coalesce(
            (SELECT max(r.sent_at) FROM wa_messages r WHERE r.conversation_id = ${conversationId} AND r.from_me),
            '-infinity'::timestamptz)
      ))`,
    })
    .where('id', '=', conversationId)
    .execute();
}

/** Contatos que ficaram sem conversa nenhuma saem também (nome e telefone não ficam guardados à toa). */
async function removeOrphanContacts(tx: Db, contactIds: number[]): Promise<void> {
  if (!contactIds.length) return;
  await tx
    .deleteFrom('wa_contacts')
    .where('id', 'in', contactIds)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('wa_conversations as c').select('c.id').whereRef('c.contact_id', '=', 'wa_contacts.id'),
        ),
      ),
    )
    .execute();
}

/**
 * Apaga mensagens de uma conversa.
 * - Para mim: somem só do sistema (o contato continua vendo no WhatsApp dele).
 * - Para todos: somem também do WhatsApp do contato. Só mensagens enviadas pelo número, dos últimos 2 dias.
 */
export async function deleteMessages(
  db: Db,
  user: AuthUser,
  conversationId: number,
  messageIds: number[],
  forEveryone: boolean,
  ip: string | null,
): Promise<{ deleted: number; failed: number; ids: number[] }> {
  // O número da conversa (quem vê, quem apaga e por onde apagar para todos).
  const instance = await db
    .selectFrom('wa_conversations as c')
    .innerJoin('wa_instances as i', 'i.id', 'c.instance_id')
    .selectAll('i')
    .where('c.id', '=', conversationId)
    .executeTakeFirst();
  if (!instance || !canSeeNumber(user, instance)) throw notFound('Conversa não encontrada.');
  if (!canManageNumber(user, instance)) throw forbidden(NO_PERMISSION);
  const ids = [...new Set(messageIds)];
  const messages = await db
    .selectFrom('wa_messages')
    .select(['id', 'wa_id', 'remote_jid', 'from_me', 'sent_at'])
    .where('conversation_id', '=', conversationId)
    .where('id', 'in', ids)
    .execute();
  if (messages.length !== ids.length) {
    throw notFound('Alguma mensagem não foi encontrada. Atualize a conversa e tente de novo.');
  }

  let toDelete = messages;
  let failed = 0;
  if (forEveryone) {
    const limit = Date.now() - FOR_EVERYONE_LIMIT_MS;
    if (messages.some((m) => !m.from_me || m.sent_at.getTime() < limit)) {
      throw badRequest(
        'Só dá para apagar para todos as mensagens enviadas pelo número nas últimas 48 horas.',
      );
    }
    await ensureConnected(db, instance);
    toDelete = [];
    for (const m of messages) {
      try {
        await evolution.deleteForEveryone(instance.name, { id: m.wa_id, remoteJid: m.remote_jid });
        toDelete.push(m);
      } catch (error) {
        failed++;
        console.error(`[apagar] mensagem ${m.id}:`, (error as Error).message);
      }
    }
    if (!toDelete.length) {
      evolutionFailure(
        new EvolutionError(502, 'o WhatsApp não aceitou apagar', 'deleteMessageForEveryone'),
        'Não foi possível apagar para todos',
      );
    }
  }

  const deletedIds = toDelete.map((m) => m.id);
  const mediaPaths = await enqueue(() =>
    db.transaction().execute(async (tx) => {
      const paths = await purgeMessages(tx, deletedIds);
      await refreshConversation(tx, conversationId);
      return paths;
    }),
  );
  await removeMediaFiles(mediaPaths);
  await audit(db, {
    userId: user.id,
    action: 'apagou_mensagens',
    entity: 'conversa',
    entityId: String(conversationId),
    details: { quantidade: deletedIds.length, para_todos: forEveryone, numero: instance.name },
    ip,
  });
  await publishMessagesDeleted(instance.id, instance.owner_id, conversationId, deletedIds);
  await publishConversation(conversationId);
  return { deleted: deletedIds.length, failed, ids: deletedIds };
}

/**
 * Exclui conversas do sistema (com as mensagens e os arquivos). No celular elas continuam; se o contato
 * escrever de novo, a conversa volta a aparecer só com as mensagens novas.
 */
export async function deleteConversations(
  db: Db,
  user: AuthUser,
  conversationIds: number[],
  ip: string | null,
): Promise<{ deleted: number; messages: number }> {
  const ids = [...new Set(conversationIds)];
  const rows = await db
    .selectFrom('wa_conversations as c')
    .innerJoin('wa_instances as i', 'i.id', 'c.instance_id')
    .select(['c.id', 'c.contact_id', 'i.id as instance_id', 'i.owner_id', 'i.name'])
    .where('c.id', 'in', ids)
    .execute();
  // Conversa que a pessoa nem vê: 404 (não revela que existe). Vê mas não cuida do número: 403.
  if (rows.length !== ids.length || rows.some((r) => !canSeeNumber(user, r))) {
    throw notFound('Alguma conversa não foi encontrada. Atualize a lista e tente de novo.');
  }
  if (rows.some((r) => !canManageNumber(user, r))) throw forbidden(NO_PERMISSION);

  const { mediaPaths, messageCount } = await enqueue(() =>
    db.transaction().execute(async (tx) => {
      const messageIds = (
        await tx.selectFrom('wa_messages').select('id').where('conversation_id', 'in', ids).execute()
      ).map((m) => m.id);
      const paths = await purgeMessages(tx, messageIds);
      await tx.deleteFrom('wa_conversations').where('id', 'in', ids).execute();
      await removeOrphanContacts(
        tx,
        rows.map((r) => r.contact_id),
      );
      return { mediaPaths: paths, messageCount: messageIds.length };
    }),
  );
  await removeMediaFiles(mediaPaths);
  await audit(db, {
    userId: user.id,
    action: 'excluiu_conversas',
    entity: 'conversa',
    details: { quantidade: rows.length, mensagens: messageCount },
    ip,
  });
  for (const r of rows) await publishConversationDeleted(r.id, r.instance_id, r.owner_id);
  return { deleted: rows.length, messages: messageCount };
}

/**
 * Exclui o número: desconecta do celular e remove da Evolution, e apaga do sistema as conversas,
 * mensagens e arquivos dele. Para confirmar, a pessoa digita EXCLUIR.
 */
export async function deleteNumber(
  db: Db,
  user: AuthUser,
  instanceId: number,
  confirm: string,
  ip: string | null,
): Promise<{ conversations: number; messages: number }> {
  if (confirm.trim().toLowerCase() !== 'excluir') throw badRequest('Para excluir, digite EXCLUIR.');
  const instance = await manageableNumber(db, user, instanceId);

  // Primeiro na Evolution: se ela recusar, nada muda aqui. Número que ela já não tem segue a exclusão.
  markInstanceDeleted(instance.name);
  await evolution.deleteInstance(instance.name).catch((error) => {
    if (error instanceof EvolutionError && error.status === 404) return;
    unmarkInstanceDeleted(instance.name);
    evolutionFailure(error, 'Não foi possível excluir o número');
  });

  const result = await enqueue(() =>
    db.transaction().execute(async (tx) => {
      const conversations = await tx
        .selectFrom('wa_conversations')
        .select(['id', 'contact_id'])
        .where('instance_id', '=', instance.id)
        .execute();
      const removed = await tx
        .deleteFrom('wa_messages')
        .where('instance_id', '=', instance.id)
        .returning('media_path')
        .execute();
      await tx.deleteFrom('wa_conversations').where('instance_id', '=', instance.id).execute();
      await removeOrphanContacts(
        tx,
        conversations.map((c) => c.contact_id),
      );
      await tx.deleteFrom('wa_instances').where('id', '=', instance.id).execute();
      return {
        conversations: conversations.length,
        messages: removed.length,
        mediaPaths: removed.map((m) => m.media_path).filter((p): p is string => !!p),
      };
    }),
  );
  await removeMediaFiles(result.mediaPaths);
  await audit(db, {
    userId: user.id,
    action: 'excluiu_numero',
    entity: 'numero',
    entityId: instance.name,
    details: {
      apelido: instance.nickname,
      conversas: result.conversations,
      mensagens: result.messages,
    },
    ip,
  });
  await publishInstanceDeleted(instance.id, instance.owner_id);
  return { conversations: result.conversations, messages: result.messages };
}
