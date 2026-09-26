/**
 * Biblioteca de áudios do "Chamar" (Plano A). O dono e o administrador salvam várias versões da mesma
 * mensagem; quando o atendente escolhe o número, o sistema sorteia uma versão ativa e a envia como
 * mensagem de voz para o lead. Assim não vai sempre o mesmo áudio para todos os clientes.
 */
import { randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'kysely';
import type { AudioItem } from '../../../shared/conversations';
import { can } from '../../../shared/roles';
import type { AuthUser } from '../../auth/sessions';
import type { Db } from '../../db';
import type { WaAudio } from '../../db/schema';
import { audit } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { shuffled } from '../../lib/shuffle';
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

/** Um áudio da biblioteca pronto para enviar (o caminho já aponta para o arquivo no volume de mídias). */
export interface AudioPick {
  id: number;
  label: string;
  path: string;
  mime: string;
}

/**
 * Rodízio de áudios com "saco embaralhado" GUARDADO NO BANCO (`wa_audio_bags`, uma linha por escopo). Os áudios
 * ativos são embaralhados e saem um de cada vez; só depois de sair todos o saco é embaralhado de novo, e o
 * primeiro do saco novo nunca repete o último do anterior (quando há mais de um áudio). Com um áudio só, sai o único.
 *
 * - Só entram áudios ATIVOS e com arquivo. Áudio excluído ou desligado sai do saco na hora.
 * - A linha do escopo fica travada (FOR UPDATE) até o fim da transação: dois workers ao mesmo tempo nunca
 *   levam o mesmo "próximo áudio".
 * - Sobrevive a reinício do Node e do Docker, e serve a vários processos.
 *
 * O escopo separa os rodízios: `campaign:<id>`, `automation:<id>` ou `instance:<id>` (o botão Chamar).
 * PRECISA rodar dentro de uma transação (`pickAudio` abre uma quando ainda não há).
 */
export async function pickAudioIn(tx: Db, scope: string): Promise<AudioPick | null> {
  await tx
    .insertInto('wa_audio_bags')
    .values({ scope })
    .onConflict((oc) => oc.column('scope').doNothing())
    .execute();
  const bag = await tx
    .selectFrom('wa_audio_bags')
    .selectAll()
    .where('scope', '=', scope)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const active = await tx
    .selectFrom('wa_audios')
    .select(['id', 'label', 'media_path', 'media_mime'])
    .where('active', '=', true)
    .where('media_path', '<>', '')
    .orderBy('id')
    .execute();
  if (!active.length) return null;

  const activeIds = new Set(active.map((a) => a.id));
  let remaining = bag.remaining.filter((id) => activeIds.has(id));
  if (!remaining.length) {
    remaining = shuffled(active.map((a) => a.id));
    if (remaining.length > 1 && remaining[0] === bag.last_audio_id) {
      const j = 1 + randomInt(remaining.length - 1);
      [remaining[0], remaining[j]] = [remaining[j] as number, remaining[0] as number];
    }
  }
  const [chosenId, ...rest] = remaining as [number, ...number[]];
  await tx
    .updateTable('wa_audio_bags')
    .set({ remaining: rest, last_audio_id: chosenId, updated_at: sql`now()` })
    .where('scope', '=', scope)
    .execute();
  const chosen = active.find((a) => a.id === chosenId) as (typeof active)[number];
  return {
    id: chosen.id,
    label: chosen.label,
    path: mediaPathOf(chosen.media_path),
    mime: chosen.media_mime,
  };
}

export const pickAudio = (db: Db, scope: string): Promise<AudioPick | null> =>
  db.transaction().execute((tx) => pickAudioIn(tx, scope));

/**
 * Sorteia o áudio do botão Chamar para um número: o mesmo rodízio persistente das campanhas, com um saco por
 * número. (Antes o "último áudio" ficava só na memória do processo e se perdia a cada reinício.)
 */
export const pickAudioForInstance = (db: Db, instanceId: number): Promise<AudioPick | null> =>
  pickAudio(db, `instance:${instanceId}`);

/** Lê os bytes de um áudio da biblioteca (para reenviar pela Evolution). */
export function readAudioBytes(path: string): Promise<Buffer> {
  return readFile(path);
}
