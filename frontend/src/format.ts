import type { ConversationItem } from './api.ts';

// 5511912345678 → +55 (11) 91234-5678
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

// Texto e cor do status de conexão de um número.
export function statusInfo(status: string): { label: string; tone: 'ok' | 'wait' | 'off' } {
  if (status === 'open') return { label: 'Conectado', tone: 'ok' };
  if (status === 'connecting') return { label: 'Conectando…', tone: 'wait' };
  return { label: 'Desconectado', tone: 'off' };
}

// Cor fixa por número, para diferenciar os WhatsApps na lista.
const INSTANCE_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#65a30d'];
export function instanceColor(id: number): string {
  return INSTANCE_COLORS[(id - 1) % INSTANCE_COLORS.length];
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysAgo = (iso: string) => Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86_400_000);

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// Horário na lista de conversas: 14:32 / Ontem / seg. / 12/09/26
export function listTime(iso: string): string {
  const days = daysAgo(iso);
  if (days <= 0) return timeOf(iso);
  if (days === 1) return 'Ontem';
  if (days < 7) return new Date(iso).toLocaleDateString('pt-BR', { weekday: 'short' });
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// Separador de dia dentro do chat: Hoje / Ontem / 12/09/2026
export function dayLabel(iso: string): string {
  const days = daysAgo(iso);
  if (days <= 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  return new Date(iso).toLocaleDateString('pt-BR');
}

// Iniciais para o avatar: "Maria Souza" → MS. Sem nome (só telefone), fica vazio e o avatar mostra um ícone.
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.length === 0) return '';
  const first = words[0].charAt(0);
  const last = words.length > 1 ? words.at(-1)!.charAt(0) : '';
  return (first + last).toUpperCase();
}

// Tom de cor fixo para cada pessoa (mesmo nome = mesma cor). Evita os amarelos, que ficam apagados.
const HUES = [0, 18, 32, 150, 168, 188, 205, 222, 245, 265, 290, 318, 340];
export function hueOf(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return HUES[Math.abs(hash) % HUES.length];
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
