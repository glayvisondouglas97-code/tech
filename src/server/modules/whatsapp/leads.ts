/** Botão "Chamar" do lead: abre a conversa pelo número escolhido, dentro do sistema (sem wa.me). */
import type { Kysely } from 'kysely';
import type { LeadAudioResult, LeadChatResult } from '../../../shared/conversations';
import type { AuthUser } from '../../auth/sessions';
import type { Database } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { triggerLeadCalled } from '../automations/triggers';
import { displayPhone } from '../imports/phone';
import { leadForChat, markWhatsappOpened } from '../leads/service';
import { visibleNumber } from './access';
import { pickAudioForInstance, readAudioBytes } from './audios';
import { evolution } from './evolution';
import { ensureConnected, evolutionFailure, sendToConversation } from './messaging';
import { contactJidsOf } from './parse';
import { enqueue } from './queue';
import {
  auditContactLimit,
  checkInstanceDailyQuota,
  isFirstContact,
  limitReachedError,
  quotaDate,
} from './quota';
import { openLeadConversation } from './store';

/**
 * Confere se o número escolhido está conectado e se o lead tem WhatsApp, abre (ou reaproveita) a
 * conversa com ele e registra no histórico do lead que o WhatsApp foi aberto. Quando `sendAudio` é
 * verdadeiro (Plano A), sorteia um áudio salvo e o envia como mensagem de voz para o lead.
 */
export async function startLeadChat(
  db: Kysely<Database>,
  user: AuthUser,
  leadId: number,
  instanceId: number,
  sendAudio = false,
): Promise<LeadChatResult> {
  const lead = await leadForChat(db, user, leadId);
  // O atendente chama só pelos números dele; dono, administrador e supervisor, por qualquer um.
  const instance = await visibleNumber(db, user, instanceId);
  await ensureConnected(db, instance);

  const result = await evolution
    .whatsappNumbers(instance.name, [lead.phone])
    .catch((error) => evolutionFailure(error, 'Não foi possível conferir o número do lead'));
  const check = Array.isArray(result) ? result[0] : undefined;
  if (!check) {
    throw new AppError(
      502,
      'Não foi possível conferir o número do lead: resposta inesperada da Evolution.',
      'whatsapp',
    );
  }
  if (!check.exists) {
    throw new AppError(422, `O número ${displayPhone(lead.phone)} não tem WhatsApp.`, 'sem_whatsapp');
  }

  const jids = contactJidsOf(check, lead.phone);
  const conversation = await enqueue(() => openLeadConversation(db, instance.id, jids, lead.id));

  // Cota diária do número (manual + automático): conferida ANTES de enviar. Abrir a conversa não gasta vaga; a vaga é
  // segurada, de forma atômica, no envio (`sendAndStore`). O backend é a autoridade: escolher o mesmo número de novo não
  // contorna nada.
  if (sendAudio && (await isFirstContact(db, conversation.id))) {
    const { ok, usage } = await checkInstanceDailyQuota(db, instance.id, quotaDate());
    if (!ok) {
      await auditContactLimit(db, {
        instanceId: instance.id,
        usage,
        origin: 'manual',
        situation: 'recusado',
        userId: user.id,
      }).catch(() => {});
      throw limitReachedError();
    }
  }
  const { warning } = await markWhatsappOpened(db, user, lead.id);

  const chat: LeadChatResult = { conversationId: conversation.id, warning };
  if (sendAudio) chat.audio = await sendLeadAudio(db, user, conversation.id, instance.id);
  // Automações "quando um lead for chamado": só aqui, no "Chamar", e só se a mensagem inicial de fato saiu.
  // Uma mensagem digitada à mão na conversa não passa por este ponto. Um erro da automação nunca derruba o "Chamar".
  if (chat.audio?.sent) {
    await triggerLeadCalled(db, {
      leadId: lead.id,
      instanceId: instance.id,
      userId: user.id,
      at: new Date(),
    }).catch((error) =>
      console.error('[chamar] não foi possível iniciar as automações:', (error as Error).message),
    );
  }
  return chat;
}

/**
 * Sorteia um áudio ativo da biblioteca e o envia pela conversa. Se não há áudio salvo, apenas avisa
 * (a conversa fica aberta para gravar na hora). Uma falha no envio não derruba o "Chamar": a conversa
 * já está aberta e o atendente pode gravar manualmente.
 */
async function sendLeadAudio(
  db: Kysely<Database>,
  user: AuthUser,
  conversationId: number,
  instanceId: number,
): Promise<LeadAudioResult> {
  const audio = await pickAudioForInstance(db, instanceId);
  if (!audio) return { sent: false, label: null, reason: 'sem_audios' };
  try {
    const data = await readAudioBytes(audio.path);
    await sendToConversation(
      db,
      conversationId,
      user.id,
      (name, number) => evolution.sendAudio(name, number, data.toString('base64')),
      { data, mime: audio.mime },
    );
    return { sent: true, label: audio.label };
  } catch (error) {
    // Cota cheia (corrida entre a conferência e o envio) é um erro para o atendente ver, não um "áudio não saiu".
    if (error instanceof AppError && error.code === 'limite_numero') throw error;
    console.error(`[chamar] não foi possível enviar o áudio sorteado:`, (error as Error).message);
    return { sent: false, label: audio.label };
  }
}
