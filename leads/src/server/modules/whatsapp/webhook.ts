import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import type { Database } from '../../db/schema';
import { addEvents } from '../../lib/events';

/**
 * Integração futura com a WhatsApp Business Cloud API (desligada por padrão: WHATSAPP_CLOUD_ENABLED=false).
 * Hoje só recebe o webhook: respostas dos clientes e status de entrega viram eventos no histórico do lead,
 * e "Mensagem enviada" passa sozinho para "Respondeu" quando o cliente responde.
 * O envio continua manual (click-to-chat). Veja docs/WHATSAPP-CLOUD-API.md.
 */

export function validSignature(appSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const got = Buffer.from(header.slice(7), 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

interface WaMessage {
  from?: string;
  type?: string;
  text?: { body?: string };
  timestamp?: string;
}
interface WaStatus {
  recipient_id?: string;
  status?: string;
  timestamp?: string;
}
interface WaPayload {
  entry?: { changes?: { value?: { messages?: WaMessage[]; statuses?: WaStatus[] } }[] }[];
}

async function latestLeadFor(db: Kysely<Database>, phone: string) {
  return db
    .selectFrom('leads')
    .select(['id', 'result', 'status'])
    .where('phone', '=', phone.replace(/\D/g, ''))
    .where('anonymized_at', 'is', null)
    .orderBy(sql`called_at DESC NULLS LAST`)
    .orderBy('id', 'desc')
    .executeTakeFirst();
}

export async function processWebhook(
  db: Kysely<Database>,
  payload: WaPayload,
): Promise<{ messages: number; statuses: number }> {
  await db
    .insertInto('whatsapp_webhook_events')
    .values({ payload: JSON.stringify(payload) })
    .execute();
  let messages = 0;
  let statuses = 0;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        if (!m.from) continue;
        const lead = await latestLeadFor(db, m.from);
        if (!lead) continue;
        messages++;
        await addEvents(db, [
          {
            leadId: lead.id,
            userId: null,
            type: 'whatsapp_resposta',
            data: { tipo: m.type ?? 'texto', texto: m.text?.body?.slice(0, 500) ?? null },
          },
        ]);
        if (lead.status === 'chamado' && lead.result === 'enviado') {
          await db
            .updateTable('leads')
            .set({ result: 'respondeu', version: sql`version + 1`, updated_at: sql`now()` })
            .where('id', '=', lead.id)
            .where('result', '=', 'enviado')
            .execute();
          await addEvents(db, [
            {
              leadId: lead.id,
              userId: null,
              type: 'resultado',
              data: { de: 'enviado', para: 'respondeu', automatico: true },
            },
          ]);
        }
      }
      for (const s of change.value?.statuses ?? []) {
        if (!s.recipient_id || !s.status) continue;
        const lead = await latestLeadFor(db, s.recipient_id);
        if (!lead) continue;
        statuses++;
        await addEvents(db, [
          { leadId: lead.id, userId: null, type: 'whatsapp_status', data: { status: s.status } },
        ]);
      }
    }
  }
  return { messages, statuses };
}
