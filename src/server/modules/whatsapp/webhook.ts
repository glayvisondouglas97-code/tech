/** Eventos que a Evolution entrega no webhook (rede interna do Docker, protegido por token). */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema';
import { cancelRunsOnReply } from '../automations/runs';
import { markRepliedFromChat } from '../leads/service';
import { scheduleHistoryImport } from './history';
import { isRecentlyDeleted } from './instances';
import { isMediaMessage, scheduleMediaDownload } from './media';
import type { WaMessage as RawMessage } from './parse';
import { enqueue } from './queue';
import { publishConversation, publishQrCode } from './realtime';
import { saveMessage, updateMessageStatus, upsertInstance } from './store';

const digest = (value: string) => createHash('sha256').update(value).digest();

export function isValidWebhookToken(received: string | undefined, expected: string): boolean {
  return !!received && !!expected && timingSafeEqual(digest(received), digest(expected));
}

// biome-ignore lint/suspicious/noExplicitAny: o conteúdo dos eventos da Evolution tem formato livre.
type EventData = any;

export async function handleEvolutionEvent(
  db: Kysely<Database>,
  event: string,
  instanceName: string,
  data: EventData,
): Promise<void> {
  if (isRecentlyDeleted(instanceName)) return; // aviso atrasado de um número que acabou de ser excluído
  switch (event) {
    case 'messages.upsert': // recebida, ou enviada pelo celular
    case 'send.message': // enviada pelo sistema
      for (const message of (Array.isArray(data) ? data : [data]) as RawMessage[]) {
        const saved = await enqueue(() => saveMessage(db, instanceName, message, { live: true }));
        // Áudio/imagem/documento recebido (ou enviado pelo celular): já baixa o arquivo em segundo plano.
        if (saved && event === 'messages.upsert' && isMediaMessage(saved.message)) {
          scheduleMediaDownload(db, saved.message);
        }
        // O lead chamado pelo sistema respondeu: o resultado dele passa sozinho para "Respondeu".
        if (saved && !saved.message.from_me && saved.conversation.lead_id) {
          const leadId = saved.conversation.lead_id;
          // Automações: o lead respondeu, então as participações DELE neste número são canceladas na hora
          // (sem esperar o job). Antes de qualquer outra coisa: se algo abaixo falhar, o cancelamento já valeu.
          await cancelRunsOnReply(db, leadId, saved.conversation.instance_id).catch((error) =>
            console.error(
              `[webhook] não foi possível cancelar as automações do lead ${leadId}:`,
              (error as Error).message,
            ),
          );
          const text = saved.message.text ?? saved.conversation.last_message_preview;
          const marked = await markRepliedFromChat(db, leadId, text).catch((error) => {
            console.error(`[webhook] não foi possível marcar o lead ${leadId}:`, (error as Error).message);
            return false;
          });
          // A tela do chat atualiza a faixa do lead com o resultado novo.
          if (marked) await publishConversation(saved.conversation.id);
        }
      }
      return;
    case 'messages.update':
      if (data?.keyId && data?.status) {
        await enqueue(() => updateMessageStatus(db, instanceName, data.keyId, data.status));
      }
      return;
    case 'messages.set':
      scheduleHistoryImport(db, instanceName);
      return;
    case 'connection.update':
      if (data?.state) {
        const before = await db
          .selectFrom('wa_instances')
          .select('status')
          .where('name', '=', instanceName)
          .executeTakeFirst();
        await enqueue(() => upsertInstance(db, instanceName, { status: data.state, phoneJid: data.wuid }));
        if (before?.status !== data.state) console.log(`[conexão] ${instanceName}: ${data.state}`);
      }
      return;
    case 'qrcode.updated': {
      // Novo QR Code para a tela de números. Sem base64 = limite de QR Codes atingido (expirou).
      const instance = await enqueue(() => upsertInstance(db, instanceName));
      await publishQrCode(instance.id, typeof data?.qrcode?.base64 === 'string' ? data.qrcode.base64 : null);
      return;
    }
    default:
      return;
  }
}
