/**
 * Mídias (áudio, imagem, vídeo, documento, figurinha): ficam em arquivos na pasta de mídias, nunca no banco.
 * Mídia recebida ao vivo é baixada logo; a do histórico, só quando alguém abre.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Kysely } from 'kysely';
import type { Config } from '../../config';
import type { Database, WaMessage } from '../../db/schema';
import { evolution } from './evolution';
import { MEDIA_TYPES, type MessageType } from './parse';
import { publishMessage } from './realtime';

let mediaDir = resolve('media');

export function configureMedia(cfg: Config): void {
  mediaDir = resolve(cfg.MEDIA_DIR);
}

const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
};

/**
 * Tipos que o navegador pode abrir direto na página. Os demais são sempre baixados (evita conteúdo
 * perigoso, como HTML ou SVG enviados por um contato, rodando dentro do sistema).
 */
const INLINE_TYPES = /^(image\/(jpeg|png|webp|gif)|audio\/[\w.+-]+|video\/(mp4|webm))$/;

export const baseMime = (mime: string | null | undefined) =>
  (mime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

export function extensionFor(mime: string, fileName: string | null): string {
  const fromName = fileName?.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  return EXTENSIONS[baseMime(mime)] ?? fromName ?? 'bin';
}

/** Caminho absoluto de um arquivo dentro da pasta de mídias (a partir do caminho relativo guardado). */
export function mediaPathOf(relative: string): string {
  return join(mediaDir, relative);
}

/** Grava um arquivo na pasta de mídias (ex.: um áudio da biblioteca), criando as pastas se preciso. */
export async function writeMediaFile(relative: string, data: Buffer): Promise<void> {
  const absolute = join(mediaDir, relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, data);
}

export function isMediaMessage(message: Pick<WaMessage, 'type'>): boolean {
  return MEDIA_TYPES.has(message.type as MessageType);
}

export function mediaFile(message: Pick<WaMessage, 'media_path'>): string | null {
  return message.media_path ? join(mediaDir, message.media_path) : null;
}

export function isInline(mime: string | null): boolean {
  return INLINE_TYPES.test(baseMime(mime));
}

/** Grava o arquivo da mensagem e registra o caminho no banco. */
export async function storeMedia(
  db: Kysely<Database>,
  message: WaMessage,
  data: Buffer,
  mime: string,
): Promise<WaMessage> {
  const relative = `${message.instance_id}/${message.id}.${extensionFor(mime, message.file_name)}`;
  const absolute = join(mediaDir, relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, data);
  const updated = await db
    .updateTable('wa_messages')
    .set({ media_path: relative, media_mime: mime })
    .where('id', '=', message.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await publishMessage('message:updated', updated);
  return updated;
}

/** Apaga os arquivos (LGPD). Erros são ignorados: o registro no banco já foi removido. */
export async function removeMediaFiles(paths: string[]): Promise<void> {
  for (const path of paths) await rm(join(mediaDir, path), { force: true }).catch(() => {});
}

/** Gravações/downloads em andamento, por mensagem (número + ID do WhatsApp). */
const inFlight = new Map<string, Promise<WaMessage>>();
const keyOf = (instanceId: number, waId: string) => `${instanceId}:${waId}`;

/**
 * Ao enviar um arquivo, avisa que ele já está sendo gravado: quem pedir a mídia nesse meio tempo
 * espera a gravação em vez de baixar uma segunda cópia pela Evolution.
 */
export function holdMedia(instanceId: number, waId: string, work: Promise<WaMessage>): void {
  const key = keyOf(instanceId, waId);
  inFlight.set(key, work);
  const release = () => inFlight.get(key) === work && inFlight.delete(key);
  work.then(release, release);
}

/** Garante que a mídia está no disco: se não estiver, baixa pela Evolution (uma vez só, mesmo com pedidos simultâneos). */
export function ensureMedia(db: Kysely<Database>, message: WaMessage): Promise<WaMessage> {
  const file = mediaFile(message);
  if (file && existsSync(file)) return Promise.resolve(message);
  const key = keyOf(message.instance_id, message.wa_id);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const download = (async () => {
    const instance = await db
      .selectFrom('wa_instances')
      .select('name')
      .where('id', '=', message.instance_id)
      .executeTakeFirstOrThrow();
    const media = await evolution.downloadMedia(instance.name, message.wa_id);
    const mime = media.mimetype || message.media_mime || 'application/octet-stream';
    return storeMedia(db, message, Buffer.from(media.base64, 'base64'), mime);
  })();
  holdMedia(message.instance_id, message.wa_id, download);
  return download;
}

/** Baixa em segundo plano, uma de cada vez, as mídias que acabaram de chegar. */
let downloads: Promise<unknown> = Promise.resolve();
export function scheduleMediaDownload(db: Kysely<Database>, message: WaMessage): void {
  downloads = downloads.then(() =>
    ensureMedia(db, message).catch((error) =>
      console.error(
        `[mídia] não foi possível baixar a mídia da mensagem ${message.id}:`,
        (error as Error).message,
      ),
    ),
  );
}
