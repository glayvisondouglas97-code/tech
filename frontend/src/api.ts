// Chamadas ao backend (/api). O navegador nunca fala direto com a Evolution.

export type InstanceInfo = { id: number; name: string; nickname: string | null; phone: string | null; status: string };

export type ConversationItem = {
  id: number;
  unreadCount: number;
  leadReplied: boolean;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  lastMessageFromMe: boolean;
  contact: { id: number; name: string | null; phone: string | null };
  instance: { id: number; name: string; nickname: string | null; status: string };
};

export type ChatMessage = {
  id: number;
  conversationId: number;
  waId: string;
  fromMe: boolean;
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'reaction' | 'other';
  text: string | null;
  fileName: string | null;
  mediaMime: string | null;
  status: string | null;
  sentAt: string;
};

export type Tab = 'responderam' | 'todas';

// Selos do menu: conversas com mensagens não lidas e números desconectados.
export type Stats = { unreadConversations: number; disconnectedInstances: number };

export const PAGE_SIZE = 50;

export type CurrentUser = { id: number; name: string; email: string; isAdmin: boolean; active: boolean };

// Sessão expirada ou encerrada (ex.: senha redefinida): avisa o App, que volta para a tela de login.
function checkAuth(response: Response, path: string) {
  if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('auth-expired'));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  checkAuth(response, path);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Erro ${response.status}`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

// Envia um arquivo como o próprio corpo da requisição (o backend lê o tipo pelo Content-Type).
async function upload<T>(path: string, body: Blob): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': body.type || 'application/octet-stream' },
    body,
  });
  checkAuth(response, path);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error ?? `Erro ${response.status}`);
  }
  return response.json();
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const mediaUrl = (messageId: number) => `/api/messages/${messageId}/media`;

function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string | number] => e[1] !== undefined);
  return new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

export const api = {
  me: () => request<CurrentUser>('/auth/me'),
  login: (email: string, password: string) =>
    request<CurrentUser>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),

  users: () => request<CurrentUser[]>('/users'),
  createUser: (name: string, email: string, isAdmin: boolean) =>
    request<{ user: CurrentUser; temporaryPassword: string }>('/users', {
      method: 'POST',
      body: JSON.stringify({ name, email, isAdmin }),
    }),
  updateUser: (id: number, changes: { active?: boolean; isAdmin?: boolean }) =>
    request<CurrentUser>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),
  resetPassword: (id: number) => request<{ temporaryPassword: string }>(`/users/${id}/reset-password`, { method: 'POST' }),

  instances: () => request<InstanceInfo[]>('/instances'),

  conversations: (params: { tab: Tab; instanceId?: number; q?: string; cursor?: number; limit?: number }) =>
    request<ConversationItem[]>(`/conversations?${query(params)}`),

  stats: () => request<Stats>('/stats'),

  conversation: (id: number) => request<ConversationItem>(`/conversations/${id}`),

  messages: (id: number, before?: number) =>
    request<ChatMessage[]>(`/conversations/${id}/messages?${query({ before, limit: PAGE_SIZE })}`),

  markRead: (id: number) => request<void>(`/conversations/${id}/read`, { method: 'POST' }),

  sendText: (id: number, text: string) =>
    request<ChatMessage>(`/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) }),

  sendAudio: (id: number, audio: Blob) => upload<ChatMessage>(`/conversations/${id}/audio`, audio),

  sendFile: (id: number, file: File, caption: string) =>
    upload<ChatMessage>(`/conversations/${id}/media?${query({ fileName: file.name, caption: caption || undefined })}`, file),

  createInstance: (nickname: string) =>
    request<InstanceInfo>('/instances', { method: 'POST', body: JSON.stringify({ nickname }) }),

  renameInstance: (id: number, nickname: string) =>
    request<InstanceInfo>(`/instances/${id}`, { method: 'PATCH', body: JSON.stringify({ nickname }) }),

  connectInstance: (id: number) =>
    request<{ status: 'open' | 'connecting'; qrcode: string | null }>(`/instances/${id}/connect`, { method: 'POST' }),
};

// Junta duas listas de mensagens sem repetir (a mais nova vence) e em ordem cronológica.
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id - b.id);
}

// Eventos de tempo real enviados pelo backend.
export type MessageEvent = { conversationId: number; message: ChatMessage };
export type ConversationRemovedEvent = { id: number; mergedInto: number };
export type QrCodeEvent = { instanceId: number; qrcode: string | null };

// Mesma ordem da lista: mais recente primeiro; empate pelo maior id.
export function compareConversations(a: ConversationItem, b: ConversationItem): number {
  return b.lastMessageAt.localeCompare(a.lastMessageAt) || b.id - a.id;
}
