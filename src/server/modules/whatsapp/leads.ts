/** Botão "Chamar" do lead: abre a conversa pelo número escolhido, dentro do sistema (sem wa.me). */
import type { Kysely } from 'kysely';
import type { LeadChatResult } from '../../../shared/conversations';
import type { AuthUser } from '../../auth/sessions';
import type { Database } from '../../db/schema';
import { AppError, notFound } from '../../lib/errors';
import { displayPhone } from '../imports/phone';
import { leadForChat, markWhatsappOpened } from '../leads/service';
import { evolution } from './evolution';
import { ensureConnected, evolutionFailure } from './messaging';
import { normalizeJid } from './parse';
import { enqueue } from './queue';
import { openLeadConversation } from './store';

/**
 * Identificadores do contato a partir da conferência da Evolution. O telefone volta com o 9º dígito
 * certo (com ou sem); para quem só é conhecido pelo @lid, volta o @lid.
 */
function contactJidsOf(check: { jid: string; number: string; lid?: string }, phone: string) {
  const lidJid = [check.jid, check.lid].find((j) => typeof j === 'string' && j.endsWith('@lid')) ?? null;
  const phoneJid = check.jid.endsWith('@s.whatsapp.net')
    ? normalizeJid(check.jid)
    : lidJid
      ? null
      : `${check.number || phone}@s.whatsapp.net`;
  return { phoneJid, lidJid: lidJid ? normalizeJid(lidJid) : null };
}

/**
 * Confere se o número escolhido está conectado e se o lead tem WhatsApp, abre (ou reaproveita) a
 * conversa com ele e registra no histórico do lead que o WhatsApp foi aberto.
 */
export async function startLeadChat(
  db: Kysely<Database>,
  user: AuthUser,
  leadId: number,
  instanceId: number,
): Promise<LeadChatResult> {
  const lead = await leadForChat(db, user, leadId);
  const instance = await db
    .selectFrom('wa_instances')
    .selectAll()
    .where('id', '=', instanceId)
    .executeTakeFirst();
  if (!instance) throw notFound('Número não encontrado.');
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
  const { warning } = await markWhatsappOpened(db, user, lead.id);
  return { conversationId: conversation.id, warning };
}
