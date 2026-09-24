/** Cliente da Evolution API v2.3.7. Rotas conferidas no código-fonte oficial dessa versão. */
import type { Config } from '../../config';
import type { WaKey, WaMessage } from './parse';

interface EvolutionSettings {
  url: string;
  apiKey: string;
  webhookUrl: string;
  webhookToken: string;
}

let settings: EvolutionSettings | null = null;

/** Chamado ao iniciar o servidor (só quando EVOLUTION_URL está definido). */
export function configureEvolution(cfg: Config): void {
  settings = cfg.EVOLUTION_URL
    ? {
        url: cfg.EVOLUTION_URL,
        apiKey: cfg.EVOLUTION_API_KEY,
        webhookUrl: cfg.WEBHOOK_URL,
        webhookToken: cfg.WEBHOOK_TOKEN,
      }
    : null;
}

function current(): EvolutionSettings {
  if (!settings) throw new EvolutionError(503, 'WhatsApp não configurado (EVOLUTION_URL vazio)', 'config');
  return settings;
}

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
  const { url, apiKey } = current();
  const response = await fetch(url + path, {
    method,
    headers: { apikey: apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  // biome-ignore lint/suspicious/noExplicitAny: resposta de formato livre da Evolution.
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const detail = data?.response?.message ?? data?.message ?? data;
    const message = Array.isArray(detail)
      ? detail.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))).join('; ')
      : String(detail);
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

// Webhook e opções que todo número usa. Aplicados ao criar o número e conferidos ao iniciar o backend.
const webhookConfig = () => ({
  enabled: true,
  url: current().webhookUrl,
  headers: { 'x-webhook-token': current().webhookToken },
  byEvents: false,
  base64: false,
  events: WEBHOOK_EVENTS,
});

const SETTINGS = {
  rejectCall: false,
  msgCall: '',
  groupsIgnore: true, // só conversas individuais
  alwaysOnline: false,
  readMessages: false, // tique azul só quando respondemos (decisão da Fase 0)
  readStatus: false,
  syncFullHistory: false,
};

// Resposta de /instance/connect: o QR Code (se já foi gerado) ou o estado, quando já está conectado.
export type ConnectResponse = { base64?: string; count?: number; instance?: { state: string } };

export const evolution = {
  fetchInstances: () => call<EvolutionInstance[]>('GET', '/instance/fetchInstances'),

  connectionState: (instance: string) =>
    call<{ instance: { instanceName: string; state: string } }>(
      'GET',
      path('/instance/connectionState', instance),
    ),

  // Cria o número já com webhook e opções, sem conectar (a conexão é pedida depois, na tela de números).
  createInstance: (instance: string) =>
    call('POST', '/instance/create', {
      instanceName: instance,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: false,
      ...SETTINGS,
      webhook: webhookConfig(),
    }),

  // Conecta (ou reconecta) o número. Se precisar, a Evolution gera QR Codes e avisa pelo webhook QRCODE_UPDATED.
  connect: (instance: string) => call<ConnectResponse>('GET', path('/instance/connect', instance)),

  setWebhook: (instance: string) =>
    call('POST', path('/webhook/set', instance), { webhook: webhookConfig() }),

  setSettings: (instance: string) => call('POST', path('/settings/set', instance), SETTINGS),

  findMessages: (instance: string, since: Date, until: Date, page: number, pageSize: number) =>
    call<FindMessagesResponse>('POST', path('/chat/findMessages', instance), {
      where: { messageTimestamp: { gte: since.toISOString(), lte: until.toISOString() } },
      page,
      offset: pageSize,
    }),

  sendText: (instance: string, number: string, text: string) =>
    call<WaMessage>('POST', path('/message/sendText', instance), { number, text }),

  // Mensagem de voz: a Evolution converte qualquer formato (ex.: WebM do navegador) para OGG/Opus com ffmpeg.
  sendAudio: (instance: string, number: string, audioBase64: string) =>
    call<WaMessage>('POST', path('/message/sendWhatsAppAudio', instance), { number, audio: audioBase64 }),

  // Imagem (a Evolution converte para JPEG) ou documento.
  sendMedia: (
    instance: string,
    number: string,
    media: {
      mediatype: 'image' | 'document';
      mimetype: string;
      fileName: string;
      caption?: string;
      base64: string;
    },
  ) =>
    call<WaMessage>('POST', path('/message/sendMedia', instance), {
      number,
      mediatype: media.mediatype,
      mimetype: media.mimetype,
      fileName: media.fileName,
      caption: media.caption,
      media: media.base64,
    }),

  // Baixa (e descriptografa) a mídia de uma mensagem que está no banco da Evolution.
  downloadMedia: (instance: string, waId: string) =>
    call<{ base64: string; mimetype?: string; fileName?: string }>(
      'POST',
      path('/chat/getBase64FromMediaMessage', instance),
      {
        message: { key: { id: waId } },
        convertToMp4: false,
      },
    ),

  /**
   * Confere quais números têm WhatsApp (usa a sessão do número conectado). Para celulares brasileiros,
   * a Evolution testa com e sem o 9 e devolve o jid certo.
   */
  whatsappNumbers: (instance: string, numbers: string[]) =>
    call<{ jid: string; exists: boolean; number: string; name?: string; lid?: string }[]>(
      'POST',
      path('/chat/whatsappNumbers', instance),
      { numbers },
    ),

  // Apaga para todos uma mensagem enviada pelo número (o WhatsApp só aceita nos primeiros ~2 dias).
  // A Evolution também tira a mensagem do banco dela.
  deleteForEveryone: (instance: string, key: { id: string; remoteJid: string }) =>
    call('DELETE', path('/chat/deleteMessageForEveryone', instance), { ...key, fromMe: true }),

  // Remove o número da Evolution (se estiver conectado, desconecta do celular antes).
  deleteInstance: (instance: string) => call('DELETE', path('/instance/delete', instance)),

  // A Evolution só aceita chaves com o telefone (@s.whatsapp.net), não com @lid.
  markAsRead: (instance: string, keys: Pick<WaKey, 'remoteJid' | 'fromMe' | 'id'>[]) =>
    call('POST', path('/chat/markMessageAsRead', instance), { readMessages: keys }),
};
