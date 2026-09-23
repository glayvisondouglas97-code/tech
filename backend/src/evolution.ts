// Cliente da Evolution API v2.3.7. Rotas conferidas no código-fonte oficial dessa versão.
import { config } from './config.ts';
import type { WaKey, WaMessage } from './whatsapp.ts';

export class EvolutionError extends Error {
  status: number;
  // Motivo em português, para mostrar a quem usa o sistema.
  reason: string;

  constructor(status: number, detail: string, route: string) {
    super(`Evolution ${route} → ${status}: ${detail}`);
    this.status = status;
    this.reason = friendlyReason(detail);
  }
}

function friendlyReason(detail: string): string {
  if (/"exists":\s*false/.test(detail)) return 'o número do lead não existe no WhatsApp';
  if (/not connected|connection closed/i.test(detail)) return 'o número está desconectado';
  if (/does not exist|not found/i.test(detail)) return 'número (instância) não encontrado na Evolution';
  return detail;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(config.evolutionUrl + path, {
    method,
    headers: { apikey: config.evolutionApiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const detail = data?.response?.message ?? data?.message ?? data;
    const message = Array.isArray(detail) ? detail.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))).join('; ') : String(detail);
    throw new EvolutionError(response.status, message, `${method} ${path}`);
  }
  return data as T;
}

const path = (route: string, instance: string) => `${route}/${encodeURIComponent(instance)}`;

export type EvolutionInstance = {
  name: string;
  connectionStatus: string;
  ownerJid: string | null;
};

export type FindMessagesResponse = {
  messages: {
    total: number;
    pages: number;
    currentPage: number;
    records: (WaMessage & { MessageUpdate?: { status: string }[] })[];
  };
};

export const WEBHOOK_EVENTS = [
  'MESSAGES_UPSERT', // recebidas e enviadas pelo celular
  'SEND_MESSAGE', // enviadas pelo sistema (API)
  'MESSAGES_UPDATE', // status: entregue, lida…
  'MESSAGES_SET', // histórico ao conectar
  'CONNECTION_UPDATE',
  'QRCODE_UPDATED',
];

export const evolution = {
  fetchInstances: () => call<EvolutionInstance[]>('GET', '/instance/fetchInstances'),

  connectionState: (instance: string) =>
    call<{ instance: { instanceName: string; state: string } }>('GET', path('/instance/connectionState', instance)),

  setWebhook: (instance: string) =>
    call('POST', path('/webhook/set', instance), {
      webhook: {
        enabled: true,
        url: config.webhookUrl,
        headers: { 'x-webhook-token': config.webhookToken },
        byEvents: false,
        base64: false,
        events: WEBHOOK_EVENTS,
      },
    }),

  setSettings: (instance: string) =>
    call('POST', path('/settings/set', instance), {
      rejectCall: false,
      msgCall: '',
      groupsIgnore: true, // só conversas individuais
      alwaysOnline: false,
      readMessages: false, // tique azul só quando respondemos (decisão da Fase 0)
      readStatus: false,
      syncFullHistory: false,
    }),

  findMessages: (instance: string, since: Date, until: Date, page: number, pageSize: number) =>
    call<FindMessagesResponse>('POST', path('/chat/findMessages', instance), {
      where: { messageTimestamp: { gte: since.toISOString(), lte: until.toISOString() } },
      page,
      offset: pageSize,
    }),

  sendText: (instance: string, number: string, text: string) =>
    call<WaMessage>('POST', path('/message/sendText', instance), { number, text }),

  // A Evolution só aceita chaves com o telefone (@s.whatsapp.net), não com @lid.
  markAsRead: (instance: string, keys: Pick<WaKey, 'remoteJid' | 'fromMe' | 'id'>[]) =>
    call('POST', path('/chat/markMessageAsRead', instance), { readMessages: keys }),
};
