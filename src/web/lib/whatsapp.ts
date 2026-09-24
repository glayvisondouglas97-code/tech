/** Conversas e números do WhatsApp: chamadas à API, formatos de exibição e regras de ordenação. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type {
  ChatMessage,
  ConversationItem,
  ConversationStats,
  ConversationTab,
  InstanceInfo,
} from '../../shared/conversations';
import { ApiError, api, qs } from './api';
import { useReconnect, useSocketEvent } from './socket';

export const PAGE_SIZE = 50;

let csrfForUpload = '';
/** O token CSRF vem da sessão (ver lib/session). Os envios de arquivo usam fetch direto. */
export function setUploadCsrf(token: string) {
  csrfForUpload = token;
}

/** Envia um arquivo como o próprio corpo da requisição (o servidor lê o tipo pelo Content-Type). */
async function upload<T>(path: string, body: Blob): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'content-type': body.type || 'application/octet-stream', 'x-csrf-token': csrfForUpload },
      body,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'Sem conexão com o servidor. Confira a internet e tente de novo.', 'offline');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Erro ${res.status}`);
  return data as T;
}

export const wa = {
  instances: () => api<InstanceInfo[]>('/instances'),
  createInstance: (nickname: string) => api<InstanceInfo>('/instances', { body: { nickname } }),
  renameInstance: (id: number, nickname: string) =>
    api<InstanceInfo>(`/instances/${id}`, { method: 'PATCH', body: { nickname } }),
  connectInstance: (id: number) =>
    api<{ status: 'open' | 'connecting'; qrcode: string | null }>(`/instances/${id}/connect`, { body: {} }),

  conversations: (params: {
    tab: ConversationTab;
    instanceId?: number;
    q?: string;
    cursor?: number;
    limit?: number;
  }) => api<ConversationItem[]>(`/conversations${qs(params)}`),
  stats: () => api<ConversationStats>('/conversations/stats'),
  conversation: (id: number) => api<ConversationItem>(`/conversations/${id}`),
  messages: (id: number, before?: number) =>
    api<ChatMessage[]>(`/conversations/${id}/messages${qs({ before, limit: PAGE_SIZE })}`),
  markRead: (id: number) => api<void>(`/conversations/${id}/read`, { body: {} }),
  sendText: (id: number, text: string) =>
    api<ChatMessage>(`/conversations/${id}/messages`, { body: { text } }),
  sendAudio: (id: number, audio: Blob) => upload<ChatMessage>(`/conversations/${id}/audio`, audio),
  sendFile: (id: number, file: File, caption: string) =>
    upload<ChatMessage>(
      `/conversations/${id}/media${qs({ fileName: file.name, caption: caption || undefined })}`,
      file,
    ),
};

export const mediaUrl = (messageId: number) => `/api/messages/${messageId}/media`;

/** Junta duas listas de mensagens sem repetir (a mais nova vence) e em ordem cronológica. */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id - b.id);
}

/** Mesma ordem da lista: mais recente primeiro; empate pelo maior id. */
export function compareConversations(a: ConversationItem, b: ConversationItem): number {
  return b.lastMessageAt.localeCompare(a.lastMessageAt) || b.id - a.id;
}

// ---------- exibição ----------

/** 5511912345678 → +55 (11) 91234-5678 */
export function formatPhone(phone: string | null): string {
  if (!phone) return '';
  const br = phone.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return br ? `+55 (${br[1]}) ${br[2]}-${br[3]}` : `+${phone}`;
}

export function contactName(contact: ConversationItem['contact']): string {
  return contact.name || formatPhone(contact.phone) || 'Contato sem número';
}

export function instanceLabel(instance: { name: string; nickname: string | null }): string {
  return instance.nickname || instance.name;
}

/** Texto e tom do status de conexão de um número. */
export function statusInfo(status: string): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  if (status === 'open') return { label: 'Conectado', tone: 'ok' };
  if (status === 'connecting') return { label: 'Conectando…', tone: 'warn' };
  return { label: 'Desconectado', tone: 'bad' };
}

/** Cor fixa por número, para diferenciar os WhatsApps na lista. */
const INSTANCE_COLORS = [
  '#2563eb',
  '#db2777',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#dc2626',
  '#0891b2',
  '#65a30d',
];
export function instanceColor(id: number): string {
  return INSTANCE_COLORS[(id - 1) % INSTANCE_COLORS.length] ?? '#7b7b7b';
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysAgo = (iso: string) =>
  Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86_400_000);

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** Horário na lista de conversas: 14:32 / Ontem / seg. / 12/09/26 */
export function listTime(iso: string): string {
  const days = daysAgo(iso);
  if (days <= 0) return timeOf(iso);
  if (days === 1) return 'Ontem';
  if (days < 7) return new Date(iso).toLocaleDateString('pt-BR', { weekday: 'short' });
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/** Separador de dia dentro do chat: Hoje / Ontem / 12/09/2026 */
export function dayLabel(iso: string): string {
  const days = daysAgo(iso);
  if (days <= 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  return new Date(iso).toLocaleDateString('pt-BR');
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.ceil(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Celular/tablet (tela de toque): Enter quebra a linha em vez de enviar, e o teclado não abre sozinho. */
export const isTouchDevice = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

// ---------- dados compartilhados entre as telas (menu, conversas, números) ----------

export const WA_INSTANCES = ['wa-instances'] as const;
export const WA_STATS = ['wa-stats'] as const;

export function useWaInstances(enabled = true) {
  return useQuery({ queryKey: WA_INSTANCES, queryFn: wa.instances, enabled, staleTime: 60_000 });
}

export function useWaStats(enabled = true) {
  return useQuery({ queryKey: WA_STATS, queryFn: wa.stats, enabled, refetchInterval: 120_000 });
}

/** Mantém números e selos do menu em dia pelo tempo real (usado uma vez, no Shell). */
export function useWaCacheSync(enabled: boolean) {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshStats = () => {
    if (!enabled) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void qc.invalidateQueries({ queryKey: WA_STATS }), 500);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useSocketEvent<InstanceInfo>('instance:updated', (updated) => {
    qc.setQueryData<InstanceInfo[]>(WA_INSTANCES, (prev) =>
      prev
        ? prev.some((i) => i.id === updated.id)
          ? prev.map((i) => (i.id === updated.id ? updated : i))
          : [...prev, updated].sort((a, b) => a.name.localeCompare(b.name))
        : prev,
    );
    refreshStats();
  });
  useSocketEvent('conversation:updated', refreshStats);
  useSocketEvent('conversation:removed', refreshStats);
  useSocketEvent('conversations:reload', refreshStats);
  useReconnect(() => {
    if (!enabled) return;
    void qc.invalidateQueries({ queryKey: WA_INSTANCES });
    void qc.invalidateQueries({ queryKey: WA_STATS });
  });
}
