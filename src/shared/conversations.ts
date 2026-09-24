/** Formatos do WhatsApp (números, conversas e mensagens) trocados entre o servidor e a interface. */

export interface InstanceInfo {
  id: number;
  /** Nome técnico na Evolution (ex.: whatsapp-01). */
  name: string;
  nickname: string | null;
  /** Telefone conectado, só dígitos (ex.: 5511999999999). */
  phone: string | null;
  /** open | connecting | close */
  status: string;
  /** Responsável pelo número (o atendente só vê as conversas dos números dele). */
  owner: { id: string; name: string } | null;
}

export interface ConversationItem {
  id: number;
  unreadCount: number;
  leadReplied: boolean;
  /** null = conversa aberta pelo "Chamar" do lead e ainda sem mensagens (não aparece na lista). */
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageFromMe: boolean;
  contact: { id: number; name: string | null; phone: string | null };
  instance: { id: number; name: string; nickname: string | null; status: string };
  /** Lead do Chamador ligado a esta conversa (chamado por ela). */
  lead: { id: number; label: string } | null;
}

/** Resposta do "Chamar" de um lead: a conversa para abrir e, se for o caso, o aviso de ritmo. */
export interface LeadChatResult {
  conversationId: number;
  warning: string | null;
}

/** Conversa já aberta com o lead por um dos números (para a janela de escolha do número). */
export interface LeadConversationRef {
  id: number;
  instanceId: number;
}

export type ChatMessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'reaction'
  | 'other';

export interface ChatMessage {
  id: number;
  conversationId: number;
  waId: string;
  fromMe: boolean;
  type: ChatMessageType;
  text: string | null;
  fileName: string | null;
  mediaMime: string | null;
  /** PENDING | SERVER_ACK | DELIVERY_ACK | READ | PLAYED | ERROR */
  status: string | null;
  sentAt: string;
  /** Quem da equipe enviou pelo sistema (null = recebida ou enviada pelo celular). */
  sentById: string | null;
}

/** Selos do menu: conversas com mensagens não lidas e números desconectados. */
export interface ConversationStats {
  unreadConversations: number;
  disconnectedInstances: number;
}

export type ConversationTab = 'responderam' | 'todas';

// Eventos de tempo real (Socket.io).
export interface MessageEvent {
  conversationId: number;
  message: ChatMessage;
}
export interface ConversationRemovedEvent {
  id: number;
  mergedInto: number;
}
export interface QrCodeEvent {
  instanceId: number;
  qrcode: string | null;
}

/** Tamanho máximo de arquivo enviado pelo chat (áudio, imagem ou documento). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
