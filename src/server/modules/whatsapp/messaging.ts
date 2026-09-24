/** Envio pelo mesmo número da conversa (texto, áudio e arquivos) e marcação de lidas no WhatsApp. */
import type { Kysely } from 'kysely';
import type { Database, WaInstance, WaMessage } from '../../db/schema';
import { AppError, conflict, notFound } from '../../lib/errors';
import { EvolutionError, evolution } from './evolution';
import { holdMedia, storeMedia } from './media';
import type { WaMessage as RawMessage } from './parse';
import { enqueue } from './queue';
import { saveMessage, upsertInstance } from './store';

/** Erro da Evolution vira aviso legível (502 = o problema está no WhatsApp/Evolution, não no pedido). */
export function evolutionFailure(error: unknown, what: string): never {
  if (error instanceof EvolutionError) {
    console.error('[whatsapp]', error.message);
    throw new AppError(502, `${what}: ${error.reason}`, 'whatsapp');
  }
  throw error;
}

/** Confere se o número está conectado antes de enviar. Se o status salvo não for "open", confirma na hora. */
export async function ensureConnected(db: Kysely<Database>, instance: WaInstance): Promise<void> {
  if (instance.status === 'open') return;
  const { instance: current } = await evolution
    .connectionState(instance.name)
    .catch((error) => evolutionFailure(error, 'Não foi possível conferir o número'));
  await upsertInstance(db, instance.name, { status: current.state });
  if (current.state !== 'open') {
    throw conflict(`O número ${instance.nickname ?? instance.name} está desconectado`);
  }
}

/**
 * Envia pelo mesmo número da conversa, grava a mensagem (e o arquivo, se houver) e marca como lidas
 * no WhatsApp as mensagens do contato que foram respondidas.
 */
export async function sendToConversation(
  db: Kysely<Database>,
  conversationId: number,
  userId: string,
  send: (instanceName: string, number: string) => Promise<RawMessage>,
  media?: { data: Buffer; mime: string },
): Promise<WaMessage> {
  const conversation = await db
    .selectFrom('wa_conversations as c')
    .innerJoin('wa_contacts as ct', 'ct.id', 'c.contact_id')
    .innerJoin('wa_instances as i', 'i.id', 'c.instance_id')
    .select(['c.id', 'c.instance_id', 'ct.phone_jid', 'ct.lid_jid'])
    .where('c.id', '=', conversationId)
    .executeTakeFirst();
  if (!conversation) throw notFound('Conversa não encontrada.');
  const instance = await db
    .selectFrom('wa_instances')
    .selectAll()
    .where('id', '=', conversation.instance_id)
    .executeTakeFirstOrThrow();
  const number = conversation.phone_jid ?? conversation.lid_jid;
  if (!number) throw new AppError(400, 'Contato sem número.', 'requisicao_invalida');

  await ensureConnected(db, instance);

  const sent = await send(instance.name, number).catch((error) =>
    evolutionFailure(error, 'Não foi possível enviar'),
  );

  // Se for arquivo, quem pedir a mídia antes da gravação terminar espera por ela (ver holdMedia).
  let stored: { resolve: (m: WaMessage) => void; reject: (e: unknown) => void } | undefined;
  if (media) {
    holdMedia(
      instance.id,
      sent.key.id,
      new Promise<WaMessage>((resolve, reject) => {
        stored = { resolve, reject };
      }),
    );
  }
  try {
    // O webhook de confirmação pode chegar antes desta linha; nesse caso a mensagem já está salva.
    const saved = await enqueue(() =>
      saveMessage(db, instance.name, sent, { live: true, conversationId: conversation.id }),
    );
    let message =
      saved?.message ??
      (await db
        .selectFrom('wa_messages')
        .selectAll()
        .where('instance_id', '=', instance.id)
        .where('wa_id', '=', sent.key.id)
        .executeTakeFirstOrThrow());
    // Registra quem da equipe enviou.
    if (message.sent_by !== userId) {
      message = await db
        .updateTable('wa_messages')
        .set({ sent_by: userId })
        .where('id', '=', message.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    if (media) {
      message = await storeMedia(db, message, media.data, media.mime);
      stored?.resolve(message);
    }

    markRepliedAsRead(db, instance.name, conversation.id, conversation.phone_jid, message.id).catch((error) =>
      console.error(
        `[envio] não foi possível marcar como lida a conversa ${conversation.id}:`,
        (error as Error).message,
      ),
    );
    return message;
  } catch (error) {
    stored?.reject(error);
    throw error;
  }
}

/** Ao responder, marca como lidas no WhatsApp as mensagens do contato que estavam sem resposta. */
async function markRepliedAsRead(
  db: Kysely<Database>,
  instanceName: string,
  conversationId: number,
  phoneJid: string | null,
  replyId: number,
): Promise<void> {
  if (!phoneJid) return; // a Evolution só marca como lida pelo telefone
  const previousReply = await db
    .selectFrom('wa_messages')
    .select('sent_at')
    .where('conversation_id', '=', conversationId)
    .where('from_me', '=', true)
    .where('id', '<>', replyId)
    .orderBy('sent_at', 'desc')
    .executeTakeFirst();
  let query = db
    .selectFrom('wa_messages')
    .select('wa_id')
    .where('conversation_id', '=', conversationId)
    .where('from_me', '=', false);
  // ">=": o WhatsApp informa o horário em segundos; a mensagem do contato pode ter o mesmo segundo da resposta.
  if (previousReply) query = query.where('sent_at', '>=', previousReply.sent_at);
  const unanswered = await query.orderBy('sent_at', 'desc').limit(50).execute();
  if (!unanswered.length) return;
  await evolution.markAsRead(
    instanceName,
    unanswered.map((m) => ({ remoteJid: phoneJid, fromMe: false, id: m.wa_id })),
  );
}
