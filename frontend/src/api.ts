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
  status: string | null;
  sentAt: string;
};

export type Tab = 'responderam' | 'todas';

export const PAGE_SIZE = 50;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Erro ${response.status}`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string | number] => e[1] !== undefined);
  return new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

export const api = {
  instances: () => request<InstanceInfo[]>('/instances'),

  conversations: (params: { tab: Tab; instanceId?: number; cursor?: number; limit?: number }) =>
    request<ConversationItem[]>(`/conversations?${query(params)}`),

  conversation: (id: number) => request<ConversationItem>(`/conversations/${id}`),

  messages: (id: number, before?: number) =>
    request<ChatMessage[]>(`/conversations/${id}/messages?${query({ before, limit: PAGE_SIZE })}`),

  markRead: (id: number) => request<void>(`/conversations/${id}/read`, { method: 'POST' }),

  sendText: (id: number, text: string) =>
    request<ChatMessage>(`/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) }),
};

// Junta duas listas de mensagens sem repetir (a mais nova vence) e em ordem cronológica.
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id - b.id);
}
