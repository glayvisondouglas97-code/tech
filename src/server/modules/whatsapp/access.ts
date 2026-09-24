/**
 * Quem vê e quem cuida de cada número de WhatsApp.
 * - Dono, administrador e supervisor veem as conversas de todos os números.
 * - O atendente vê só as conversas dos números de que é responsável.
 * - Dono e administrador conectam, renomeiam e trocam o responsável de qualquer número;
 *   cada pessoa cuida dos próprios números.
 */
import { sql } from 'kysely';
import { can } from '../../../shared/roles';
import type { AuthUser } from '../../auth/sessions';
import type { Db } from '../../db';
import type { WaInstance } from '../../db/schema';
import { forbidden, notFound } from '../../lib/errors';

type Owned = { owner_id: string | null };

export function canSeeNumber(user: AuthUser, instance: Owned): boolean {
  return can.seeAllNumbers(user.role) || instance.owner_id === user.id;
}

export function canManageNumber(user: AuthUser, instance: Owned): boolean {
  return can.manageNumbers(user.role) || instance.owner_id === user.id;
}

/** Filtro para consultas em que o número tem o apelido "i" (wa_instances as i). */
export function visibleNumbers(user: AuthUser) {
  if (can.seeAllNumbers(user.role)) return sql<boolean>`true`;
  return sql<boolean>`i.owner_id = ${user.id}`;
}

/** Número que a pessoa vê (senão 404, sem revelar que ele existe). */
export async function visibleNumber(db: Db, user: AuthUser, id: number): Promise<WaInstance> {
  const instance = await db.selectFrom('wa_instances').selectAll().where('id', '=', id).executeTakeFirst();
  if (!instance || !canSeeNumber(user, instance)) throw notFound('Número não encontrado.');
  return instance;
}

/** Número que a pessoa pode conectar, renomear ou reimportar. */
export async function manageableNumber(db: Db, user: AuthUser, id: number): Promise<WaInstance> {
  const instance = await visibleNumber(db, user, id);
  if (!canManageNumber(user, instance)) {
    throw forbidden('Só o responsável pelo número ou um administrador pode fazer isso.');
  }
  return instance;
}

/** Confere se a pessoa vê a conversa (pelo número dela). Senão, 404. */
export async function assertConversationVisible(
  db: Db,
  user: AuthUser,
  conversationId: number,
): Promise<void> {
  const row = await db
    .selectFrom('wa_conversations as c')
    .innerJoin('wa_instances as i', 'i.id', 'c.instance_id')
    .select('i.owner_id')
    .where('c.id', '=', conversationId)
    .executeTakeFirst();
  if (!row || !canSeeNumber(user, row)) throw notFound('Conversa não encontrada.');
}
