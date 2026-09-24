import { type Kysely, sql } from 'kysely';
import type { ListSummary } from '../../../shared/api';
import { normalizeText } from '../../../shared/text';
import type { AuthUser } from '../../auth/sessions';
import type { Database } from '../../db/schema';
import { audit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { listProgress } from '../dashboard/service';

type Db = Kysely<Database>;

export async function listLists(db: Db, includeArchived: boolean): Promise<ListSummary[]> {
  const [progress, meta] = await Promise.all([
    listProgress(db, includeArchived),
    db
      .selectFrom('lists as li')
      .leftJoin('users as u', 'u.id', 'li.created_by')
      .select([
        'li.id',
        'li.distribution',
        'li.source_file',
        'li.extra_columns',
        'li.created_by',
        'u.name as user_name',
      ])
      .execute(),
  ]);
  const byId = new Map(meta.map((m) => [m.id, m]));
  return progress.map((p) => {
    const m = byId.get(p.id);
    return {
      ...p,
      createdBy: m?.created_by ? { id: m.created_by, name: m.user_name ?? '' } : null,
      distribution: m?.distribution ?? 'fila',
      sourceFile: m?.source_file ?? null,
      extraColumns: m?.extra_columns ?? [],
    };
  });
}

async function getList(db: Db, id: string) {
  const list = await db.selectFrom('lists').selectAll().where('id', '=', id).executeTakeFirst();
  if (!list) throw notFound('Lista não encontrada.');
  return list;
}

/** Arquivar tira os leads pendentes da fila livre (ninguém pega), mas mantém tudo guardado. */
export async function setArchived(db: Db, user: AuthUser, id: string, archived: boolean, ip: string | null) {
  const list = await getList(db, id);
  await db
    .updateTable('lists')
    .set({ archived_at: archived ? sql`now()` : null })
    .where('id', '=', id)
    .execute();
  await audit(db, {
    userId: user.id,
    action: archived ? 'arquivou_lista' : 'desarquivou_lista',
    entity: 'lista',
    entityId: id,
    details: { lista: list.name },
    ip,
  });
}

export async function renameList(db: Db, user: AuthUser, id: string, name: string, ip: string | null) {
  const list = await getList(db, id);
  await db.updateTable('lists').set({ name }).where('id', '=', id).execute();
  await audit(db, {
    userId: user.id,
    action: 'renomeou_lista',
    entity: 'lista',
    entityId: id,
    details: { de: list.name, para: name },
    ip,
  });
}

/** Exclui a lista, os leads e o histórico deles. Pede o nome da lista como confirmação. */
export async function deleteList(db: Db, user: AuthUser, id: string, confirm: string, ip: string | null) {
  const list = await getList(db, id);
  if (normalizeText(confirm) !== normalizeText(list.name)) {
    throw badRequest('Para excluir, digite o nome da lista exatamente como aparece.');
  }
  await db.transaction().execute(async (trx) => {
    const r = await trx
      .selectFrom('leads')
      .select(sql<number>`count(*)`.as('n'))
      .where('list_id', '=', id)
      .executeTakeFirstOrThrow();
    await trx.deleteFrom('lists').where('id', '=', id).execute();
    await audit(trx, {
      userId: user.id,
      action: 'excluiu_lista',
      entity: 'lista',
      entityId: id,
      details: { lista: list.name, leads: r.n },
      ip,
    });
  });
}

/**
 * Exclui várias listas de uma vez (com os leads e o histórico deles). Como pode apagar muita coisa,
 * a confirmação é digitar EXCLUIR.
 */
export async function deleteLists(
  db: Db,
  user: AuthUser,
  ids: string[],
  confirm: string,
  ip: string | null,
): Promise<{ lists: number; leads: number }> {
  if (normalizeText(confirm) !== 'excluir') throw badRequest('Para excluir, digite EXCLUIR.');
  const unique = [...new Set(ids)];
  return db.transaction().execute(async (trx) => {
    const lists = await trx
      .selectFrom('lists')
      .select(['id', 'name'])
      .where('id', 'in', unique)
      .forUpdate()
      .execute();
    if (lists.length !== unique.length) {
      throw notFound('Alguma lista não foi encontrada. Atualize a página e tente de novo.');
    }
    const counts = await trx
      .selectFrom('leads')
      .select(['list_id', sql<number>`count(*)`.as('n')])
      .where('list_id', 'in', unique)
      .groupBy('list_id')
      .execute();
    const leadsOf = new Map(counts.map((c) => [c.list_id, c.n]));
    await trx.deleteFrom('lists').where('id', 'in', unique).execute();
    for (const list of lists) {
      await audit(trx, {
        userId: user.id,
        action: 'excluiu_lista',
        entity: 'lista',
        entityId: list.id,
        details: { lista: list.name, leads: leadsOf.get(list.id) ?? 0 },
        ip,
      });
    }
    return { lists: lists.length, leads: counts.reduce((sum, c) => sum + c.n, 0) };
  });
}
