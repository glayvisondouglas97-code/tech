// Mídias (áudio, imagem, vídeo, documento, figurinha): ficam em arquivos na pasta de mídias, nunca no banco.
// Mídia recebida ao vivo é baixada logo; a do histórico, só quando alguém abre.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from './config.ts';
import { prisma } from './db.ts';
import { evolution } from './evolution.ts';
import type { Message } from './generated/prisma/client.ts';
import { publishMessage } from './realtime.ts';
import { MEDIA_TYPES, type MessageType } from './whatsapp.ts';

const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
};

// Tipos que o navegador pode abrir direto na página. Os demais são sempre baixados (evita conteúdo
// perigoso, como HTML ou SVG enviados por um lead, rodando dentro do sistema).
const INLINE_TYPES = /^(image\/(jpeg|png|webp|gif)|audio\/[\w.+-]+|video\/(mp4|webm))$/;

export const baseMime = (mime: string | null | undefined) => (mime ?? '').split(';')[0].trim().toLowerCase();

function extensionFor(mime: string, fileName: string | null): string {
  const fromName = fileName?.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  return EXTENSIONS[baseMime(mime)] ?? fromName ?? 'bin';
}

export function isMediaMessage(message: Pick<Message, 'type'>): boolean {
  return MEDIA_TYPES.has(message.type as MessageType);
}

export function mediaFile(message: Pick<Message, 'mediaPath'>): string | null {
  return message.mediaPath ? join(config.mediaDir, message.mediaPath) : null;
}

export function isInline(mime: string | null): boolean {
  return INLINE_TYPES.test(baseMime(mime));
}

// Grava o arquivo da mensagem e registra o caminho no banco.
export async function storeMedia(message: Message, data: Buffer, mime: string): Promise<Message> {
  const relative = `${message.instanceId}/${message.id}.${extensionFor(mime, message.fileName)}`;
  const absolute = join(config.mediaDir, relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, data);
  const updated = await prisma.message.update({ where: { id: message.id }, data: { mediaPath: relative, mediaMime: mime } });
  publishMessage('message:updated', updated);
  return updated;
}

// Gravações/downloads em andamento, por mensagem (número + ID do WhatsApp).
const inFlight = new Map<string, Promise<Message>>();
const keyOf = (instanceId: number, waId: string) => `${instanceId}:${waId}`;

// Ao enviar um arquivo, avisa que ele já está sendo gravado: quem pedir a mídia nesse meio tempo
// espera a gravação em vez de baixar uma segunda cópia pela Evolution.
export function holdMedia(instanceId: number, waId: string, work: Promise<Message>): void {
  const key = keyOf(instanceId, waId);
  inFlight.set(key, work);
  const release = () => inFlight.get(key) === work && inFlight.delete(key);
  work.then(release, release);
}

// Garante que a mídia está no disco: se ainda não estiver, baixa pela Evolution (uma vez só, mesmo com pedidos simultâneos).
export function ensureMedia(message: Message): Promise<Message> {
  const file = mediaFile(message);
  if (file && existsSync(file)) return Promise.resolve(message);
  const key = keyOf(message.instanceId, message.waId);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const download = (async () => {
    const instance = await prisma.instance.findUniqueOrThrow({ where: { id: message.instanceId } });
    const media = await evolution.downloadMedia(instance.name, message.waId);
    const mime = media.mimetype || message.mediaMime || 'application/octet-stream';
    return storeMedia(message, Buffer.from(media.base64, 'base64'), mime);
  })();
  holdMedia(message.instanceId, message.waId, download);
  return download;
}

// Baixa em segundo plano, uma de cada vez, as mídias que acabaram de chegar.
let downloads: Promise<unknown> = Promise.resolve();
export function scheduleMediaDownload(message: Message): void {
  downloads = downloads.then(() =>
    ensureMedia(message).catch((error) =>
      console.error(`[mídia] não foi possível baixar a mídia da mensagem ${message.id}:`, (error as Error).message),
    ),
  );
}
