/** Regras sobre o formato das mensagens da Evolution/WhatsApp. Funções puras, sem banco (testes em tests/unit). */

// biome-ignore lint/suspicious/noExplicitAny: o conteúdo das mensagens do WhatsApp tem formato livre.
type Json = Record<string, any>;

export type WaKey = {
  id: string;
  remoteJid: string;
  remoteJidAlt?: string | null;
  fromMe: boolean;
  participant?: string | null;
  addressingMode?: string | null;
};

export type WaMessage = {
  key: WaKey;
  pushName?: string | null;
  message?: Json | null;
  messageType?: string;
  messageTimestamp: number | string;
  status?: string | null;
};

export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'reaction'
  | 'other';

export type ParsedContent = {
  type: MessageType;
  text: string | null;
  fileName: string | null;
  mimetype: string | null;
};

export const MEDIA_TYPES: ReadonlySet<MessageType> = new Set([
  'image',
  'video',
  'audio',
  'document',
  'sticker',
]);

// Remove o sufixo de aparelho: "5511999999999:12@s.whatsapp.net" → "5511999999999@s.whatsapp.net".
export function normalizeJid(jid: string): string {
  return jid.replace(/:\d+@/, '@');
}

// Devolve o telefone e/ou o @lid do contato. Retorna os dois nulos para grupos, status (stories) e canais.
export function contactJids(key: WaKey): { phoneJid: string | null; lidJid: string | null } {
  const jids = [key.remoteJid, key.remoteJidAlt].filter((j): j is string => !!j).map(normalizeJid);
  return {
    phoneJid: jids.find((j) => j.endsWith('@s.whatsapp.net')) ?? null,
    lidJid: jids.find((j) => j.endsWith('@lid')) ?? null,
  };
}

/**
 * Identificadores do contato a partir da conferência da Evolution. O telefone volta com o 9º dígito
 * certo (com ou sem); para quem só é conhecido pelo @lid, volta o @lid.
 */
export function contactJidsOf(check: { jid: string; number: string; lid?: string }, phone: string) {
  const lidJid = [check.jid, check.lid].find((j) => typeof j === 'string' && j.endsWith('@lid')) ?? null;
  const phoneJid = check.jid.endsWith('@s.whatsapp.net')
    ? normalizeJid(check.jid)
    : lidJid
      ? null
      : `${check.number || phone}@s.whatsapp.net`;
  return { phoneJid, lidJid: lidJid ? normalizeJid(lidJid) : null };
}

// Tipos que não são conteúdo visível (edições, exclusões, votos etc.): ignorados.
const IGNORED_TYPES = new Set([
  'protocolMessage',
  'editedMessage',
  'pollUpdateMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'keepInChatMessage',
  'encReactionMessage',
  'unknown',
]);

// "Embrulhos" cujo conteúdo real fica em message[tipo].message.
const WRAPPER_TYPES = new Set([
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
]);

function detectType(message: Json): string | undefined {
  return Object.keys(message).find((k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage');
}

// Converte o conteúdo da mensagem num formato simples. Retorna null quando a mensagem deve ser ignorada.
export function parseContent(msg: Pick<WaMessage, 'message' | 'messageType'>): ParsedContent | null {
  let message: Json = msg.message ?? {};
  let type = msg.messageType && msg.messageType in message ? msg.messageType : detectType(message);

  for (let depth = 0; type && WRAPPER_TYPES.has(type) && depth < 3; depth++) {
    message = message[type]?.message ?? {};
    type = detectType(message);
  }
  if (!type || IGNORED_TYPES.has(type)) return null;

  const content = message[type] ?? {};
  const result = (
    t: MessageType,
    text: string | null = null,
    fileName: string | null = null,
  ): ParsedContent => ({
    type: t,
    text: text || null,
    fileName: fileName || null,
    mimetype: MEDIA_TYPES.has(t) && typeof content.mimetype === 'string' ? content.mimetype : null,
  });

  switch (type) {
    case 'conversation':
      return typeof message.conversation === 'string' && message.conversation
        ? result('text', message.conversation)
        : null;
    case 'extendedTextMessage':
      return content.text ? result('text', content.text) : null;
    case 'imageMessage':
      return result('image', content.caption);
    case 'videoMessage':
    case 'ptvMessage':
      return result('video', content.caption);
    case 'audioMessage':
      return result('audio');
    case 'documentMessage':
      return result('document', content.caption, content.fileName ?? content.title);
    case 'stickerMessage':
      return result('sticker');
    case 'reactionMessage':
      // Reação removida chega com texto vazio: ignorar.
      return content.text ? result('reaction', content.text) : null;
    case 'locationMessage':
    case 'liveLocationMessage':
      return result('other', '[Localização]');
    case 'contactMessage':
    case 'contactsArrayMessage':
      return result('other', '[Contato]');
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return result('other', '[Enquete]');
    default:
      return result('other', '[Mensagem não suportada]');
  }
}

// Texto curto exibido na lista de conversas.
export function previewOf(content: ParsedContent): string {
  let preview: string;
  switch (content.type) {
    case 'image':
      preview = `📷 ${content.text ?? 'Imagem'}`;
      break;
    case 'video':
      preview = `🎥 ${content.text ?? 'Vídeo'}`;
      break;
    case 'audio':
      preview = '🎤 Áudio';
      break;
    case 'document':
      preview = `📄 ${content.fileName ?? content.text ?? 'Documento'}`;
      break;
    case 'sticker':
      preview = 'Figurinha';
      break;
    case 'reaction':
      preview = `Reagiu ${content.text}`;
      break;
    default:
      preview = content.text ?? '';
  }
  return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
}

// Ordem dos status de entrega. Webhooks podem chegar fora de ordem, então o status nunca "volta".
const STATUS_ORDER = ['ERROR', 'PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED'];

export function isNewerStatus(current: string | null | undefined, next: string | null | undefined): boolean {
  if (!next || !STATUS_ORDER.includes(next)) return false;
  if (!current) return true;
  return STATUS_ORDER.indexOf(next) > STATUS_ORDER.indexOf(current);
}

export function timestampToDate(timestamp: number | string): Date {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}
