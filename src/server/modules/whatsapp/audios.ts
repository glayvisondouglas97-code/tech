/**
 * Biblioteca de áudios do "Chamar" (Plano A). O dono e o administrador salvam várias versões da mesma
 * mensagem; quando o atendente escolhe o número, o sistema sorteia uma versão ativa e a envia como
 * mensagem de voz para o lead. Assim não vai sempre o mesmo áudio para todos os clientes.
 */
import { readFile } from 'node:fs/promises';
import type { AudioItem } from '../../../shared/conversations';
import { can } from '../../../shared/roles';
import type { AuthUser } from '../../auth/sessions';
import type { Db } from '../../db';
import type { WaAudio } from '../../db/schema';
import { audit } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { baseMime, extensionFor, mediaPathOf, removeMediaFiles, writeMediaFile } from './media';

/** Só o dono e o administrador montam a biblioteca (todo mundo usa os áudios ao chamar). */
function assertCanManage(user: AuthUser): void {
  if (!can.manageAudios(user.role)) {
    throw forbidden('Só o dono e o administrador podem cadastrar áudios.');
  }
}

function audioDto(row: WaAudio & { creator_name: string | null }): AudioItem {
  return {
    id: row.id,
    label: row.label,
    mime: row.media_mime,
    seconds: row.seconds,
    bytes: row.bytes,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by ? { id: row.created_by, name: row.creator_name ?? '—' } : null,
  };
}

const withCreator = (db: Db) =>
  db
    .selectFrom('wa_audios as a')
    .leftJoin('users as u', 'u.id', 'a.created_by')
    .selectAll('a')
    .select('u.name as creator_name');

/** Lista os áudios (ativos primeiro, depois os mais novos). */
export async function listAudios(db: Db, user: AuthUser): Promise<AudioItem[]> {
  assertCanManage(user);
  const rows = await withCreator(db).orderBy('a.active', 'desc').orderBy('a.id', 'desc').execute();
  return rows.map(audioDto);
}

const MAX_LABEL = 80;

/** Salva um áudio novo. O arquivo vai para audios/<id>.<ext> na pasta de mídias. */
export async function createAudio(
  db: Db,
  user: AuthUser,
  input: { label: string; mime: string; seconds: number | null; data: Buffer },
  ip: string | null,
): Promise<AudioItem> {
  assertCanManage(user);
  const label = input.label.trim().slice(0, MAX_LABEL);
  if (!label) throw badRequest('Dê um nome para o áudio.');
  const mime = baseMime(input.mime);
  if (!mime.startsWith('audio/')) throw badRequest('Envie um arquivo de áudio.');
  if (!input.data.length) throw badRequest('Áudio vazio.');

  // Insere primeiro para ter o id; depois grava o arquivo e guarda o caminho.
  const created = await db
    .insertInto('wa_audios')
    .values({
      label,
      media_path: '',
      media_mime: mime,
      seconds: input.seconds && input.seconds > 0 ? Math.round(input.seconds) : null,
      bytes: input.data.length,
      created_by: user.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const relative = `audios/${created.id}.${extensionFor(mime, null)}`;
  await writeMediaFile(relative, input.data);
  await db.updateTable('wa_audios').set({ media_path: relative }).where('id', '=', created.id).execute();

  await audit(db, {
    userId: user.id,
    action: 'criou_audio',
    entity: 'audio',
    entityId: created.id,
    details: { nome: label, segundos: input.seconds ?? null },
    ip,
  });
  const row = await withCreator(db).where('a.id', '=', created.id).executeTakeFirstOrThrow();
  return audioDto(row);
}

/** Liga/desliga um áudio (desligado não entra no sorteio, mas continua guardado). */
export async function setAudioActive(
  db: Db,
  user: AuthUser,
  id: number,
  active: boolean,
  ip: string | null,
): Promise<AudioItem> {
  assertCanManage(user);
  const updated = await db
    .updateTable('wa_audios')
    .set({ active })
    .where('id', '=', id)
    .returning('id')
    .executeTakeFirst();
  if (!updated) throw notFound('Áudio não encontrado.');
  await audit(db, {
    userId: user.id,
    action: active ? 'ativou_audio' : 'desativou_audio',
    entity: 'audio',
    entityId: id,
    ip,
  });
  const row = await withCreator(db).where('a.id', '=', id).executeTakeFirstOrThrow();
  return audioDto(row);
}

/** Exclui um áudio da biblioteca (e o arquivo). As mensagens já enviadas continuam nas conversas. */
export async function deleteAudio(db: Db, user: AuthUser, id: number, ip: string | null): Promise<void> {
  assertCanManage(user);
  const removed = await db
    .deleteFrom('wa_audios')
    .where('id', '=', id)
    .returning(['label', 'media_path'])
    .executeTakeFirst();
  if (!removed) throw notFound('Áudio não encontrado.');
  if (removed.media_path) await removeMediaFiles([removed.media_path]);
  await audit(db, {
    userId: user.id,
    action: 'excluiu_audio',
    entity: 'audio',
    entityId: id,
    details: { nome: removed.label },
    ip,
  });
}

/** Devolve o arquivo de um áudio para ouvir na tela (só quem gerencia a biblioteca). */
export async function audioFileForPlayback(
  db: Db,
  user: AuthUser,
  id: number,
): Promise<{ path: string; mime: string }> {
  assertCanManage(user);
  const row = await db
    .selectFrom('wa_audios')
    .select(['media_path', 'media_mime'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row?.media_path) throw notFound('Áudio não encontrado.');
  return { path: mediaPathOf(row.media_path), mime: row.media_mime };
}

/** Último áudio enviado por cada número, para o sorteio evitar repetir o mesmo em seguida. */
const lastAudioByInstance = new Map<number, number>();

/**
 * Sorteia um áudio ativo para enviar por um número. Evita repetir o último áudio que aquele número
 * enviou (quando há mais de uma opção), para variar a mensagem entre os clientes.
 */
export async function pickAudioForInstance(
  db: Db,
  instanceId: number,
): Promise<{ id: number; label: string; path: string; mime: string } | null> {
  const audios = await db
    .selectFrom('wa_audios')
    .select(['id', 'label', 'media_path', 'media_mime'])
    .where('active', '=', true)
    .where('media_path', '<>', '')
    .execute();
  if (!audios.length) return null;

  const last = lastAudioByInstance.get(instanceId);
  const pool = audios.length > 1 && last ? audios.filter((a) => a.id !== last) : audios;
  const chosen = (pool.length ? pool : audios)[Math.floor(Math.random() * (pool.length || audios.length))];
  if (!chosen) return null;
  lastAudioByInstance.set(instanceId, chosen.id);
  return {
    id: chosen.id,
    label: chosen.label,
    path: mediaPathOf(chosen.media_path),
    mime: chosen.media_mime,
  };
}

/** Lê os bytes de um áudio da biblioteca (para reenviar pela Evolution). */
export function readAudioBytes(path: string): Promise<Buffer> {
  return readFile(path);
}
