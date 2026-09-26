/** Envio pelo mesmo número da conversa (texto, áudio e arquivos) e marcação de lidas no WhatsApp. */
import { type Kysely, sql } from 'kysely';
import { INSTANCE_DAILY_CONTACT_LIMIT } from '../../../shared/quota';
import type { Database, WaInstance, WaMessage } from '../../db/schema';
import { AppError, conflict, notFound } from '../../lib/errors';
import { markSentFromChat } from '../leads/service';
import { EvolutionError, evolution } from './evolution';
import { holdMedia, storeMedia } from './media';
import type { WaMessage as RawMessage } from './parse';
import { enqueue } from './queue';
import {
  auditContactLimit,
  checkInstanceDailyQuota,
  claimContactQuota,
  confirmContactQuota,
  isFirstContact,
  limitReachedError,
  notifyUsageChanged,
  type QuotaClaim,
  quotaDate,
  releaseContactQuota,
  sendDefinitelyFailed,
} from './quota';
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

/** Quem está enviando e o que o envio deve (ou não) mexer além de mandar e gravar a mensagem. */
export interface SendActor {
  /** Quem da equipe enviou (guardado na mensagem). Vazio = envio automático, sem pessoa. */
  userId: string | null;
  /** Conversa de um lead chamado: a primeira mensagem marca o lead como "Chamado · Mensagem enviada". */
  markLeadCalled: boolean;
  /** Marca como lidas no WhatsApp as mensagens do contato que foram respondidas. */
  markRead: boolean;
  /**
   * Uma PESSOA está enviando: se esta for a primeira mensagem da conversa de um lead (contato novo), ela usa uma vaga da
   * cota diária do número (manual). A automação não usa isto: ela segura a própria vaga no executor (automático).
   */
  countsAsContact?: boolean;
}

/**
 * Envia pelo mesmo número da conversa, grava a mensagem (e o arquivo, se houver) e marca como lidas
 * no WhatsApp as mensagens do contato que foram respondidas. Se a conversa foi aberta pelo "Chamar"
 * de um lead da fila de quem enviou, o lead fica "Chamado · Mensagem enviada".
 */
export function sendToConversation(
  db: Kysely<Database>,
  conversationId: number,
  userId: string,
  send: (instanceName: string, number: string) => Promise<RawMessage>,
  media?: { data: Buffer; mime: string },
): Promise<WaMessage> {
  return sendAndStore(
    db,
    conversationId,
    { userId, markLeadCalled: true, markRead: true, countsAsContact: true },
    send,
    media,
  );
}

/**
 * O miolo do envio, usado pelo atendente (`sendToConversation`) e pelas automações. Confere o número,
 * envia pela Evolution e grava a mensagem na conversa. O que mais acontece depende de `actor`: a automação
 * não marca o lead como chamado, não mexe na fila de ninguém e não marca as mensagens do lead como lidas.
 */
export async function sendAndStore(
  db: Kysely<Database>,
  conversationId: number,
  actor: SendActor,
  send: (instanceName: string, number: string) => Promise<RawMessage>,
  media?: { data: Buffer; mime: string },
): Promise<WaMessage> {
  const conversation = await db
    .selectFrom('wa_conversations as c')
    .innerJoin('wa_contacts as ct', 'ct.id', 'c.contact_id')
    .innerJoin('wa_instances as i', 'i.id', 'c.instance_id')
    .select(['c.id', 'c.instance_id', 'c.lead_id', 'ct.phone_jid', 'ct.lid_jid'])
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

  // Contato novo feito por uma pessoa (botão Chamar ou primeira mensagem digitada para um lead): segura a vaga do dia
  // do número ANTES de enviar. Cota cheia = não envia. O mesmo mecanismo protege as campanhas (ver quota.ts).
  // A conversa é marcada primeiro (`contact_claimed_at`, de forma atômica): se dois envios chegarem juntos numa conversa
  // nova (clique duplo, áudio e texto ao mesmo tempo), só o primeiro conta como contato novo e gasta a vaga.
  let claim: QuotaClaim | null = null;
  let markedConversation = false;
  if (
    actor.countsAsContact &&
    conversation.lead_id !== null &&
    (await isFirstContact(db, conversation.id)) &&
    (await markContactClaim(db, conversation.id))
  ) {
    markedConversation = true;
    const date = quotaDate();
    claim = await claimContactQuota(db, instance.id, date);
    if (!claim) {
      await unmarkContactClaim(db, conversation.id);
      const { usage } = await checkInstanceDailyQuota(db, instance.id, date);
      await auditContactLimit(db, {
        instanceId: instance.id,
        usage,
        origin: 'manual',
        situation: 'recusado',
        userId: actor.userId,
      }).catch(() => {});
      throw limitReachedError();
    }
  }

  let sent: RawMessage;
  try {
    sent = await send(instance.name, number);
  } catch (error) {
    // Só a recusa clara devolve a vaga; qualquer dúvida sobre a mensagem ter saído mantém a vaga ocupada.
    if (claim && sendDefinitelyFailed(error)) {
      await releaseContactQuota(db, claim).catch((e) =>
        console.error('[cota] não devolveu a vaga:', (e as Error).message),
      );
      if (markedConversation) await unmarkContactClaim(db, conversation.id).catch(() => {});
      notifyUsageChanged(instance.id);
    }
    return evolutionFailure(error, 'Não foi possível enviar');
  }
  if (claim) {
    // O envio foi aceito: a vaga incerta vira contato manual. Falha aqui deixa a vaga como incerta (conservador).
    const usage = await confirmContactQuota(db, claim, 'manual').catch((e) => {
      console.error('[cota] não confirmou o contato:', (e as Error).message);
      return null;
    });
    if (usage && usage.total >= INSTANCE_DAILY_CONTACT_LIMIT) {
      await auditContactLimit(db, {
        instanceId: instance.id,
        usage,
        origin: 'manual',
        situation: 'atingido',
        userId: actor.userId,
      }).catch(() => {});
    }
    notifyUsageChanged(instance.id);
  }

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
    if (actor.userId && message.sent_by !== actor.userId) {
      message = await db
        .updateTable('wa_messages')
        .set({ sent_by: actor.userId })
        .where('id', '=', message.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    if (media) {
      message = await storeMedia(db, message, media.data, media.mime);
      stored?.resolve(message);
    }

    if (actor.markLeadCalled && actor.userId && conversation.lead_id) {
      const userId = actor.userId;
      await markSentFromChat(db, conversation.lead_id, userId, instance.nickname ?? instance.name).catch(
        (error) =>
          console.error(
            `[envio] não foi possível marcar o lead ${conversation.lead_id} como chamado:`,
            (error as Error).message,
          ),
      );
    }

    if (actor.markRead) {
      markRepliedAsRead(db, instance.name, conversation.id, conversation.phone_jid, message.id).catch(
        (error) =>
          console.error(
            `[envio] não foi possível marcar como lida a conversa ${conversation.id}:`,
            (error as Error).message,
          ),
      );
    }
    return message;
  } catch (error) {
    stored?.reject(error);
    throw error;
  }
}

/**
 * Marca que um envio segurou a vaga do primeiro contato desta conversa. Devolve false se outro envio já tinha marcado
 * (então este não é contato novo e não gasta outra vaga).
 */
async function markContactClaim(db: Kysely<Database>, conversationId: number): Promise<boolean> {
  const marked = await db
    .updateTable('wa_conversations')
    .set({ contact_claimed_at: sql`now()` })
    .where('id', '=', conversationId)
    .where('contact_claimed_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return !!marked;
}

/** A vaga não foi usada (cota cheia ou recusa clara da Evolution): a conversa volta a poder ser contato novo. */
async function unmarkContactClaim(db: Kysely<Database>, conversationId: number): Promise<void> {
  await db
    .updateTable('wa_conversations')
    .set({ contact_claimed_at: null })
    .where('id', '=', conversationId)
    .execute();
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
