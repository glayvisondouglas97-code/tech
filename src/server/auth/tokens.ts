import { sql } from 'kysely';
import type { InviteLink } from '../../shared/api';
import type { Db } from '../db';
import { badRequest } from '../lib/errors';
import { hashPassword, passwordProblem } from './password';
import { destroyUserSessions, hashToken, newToken } from './sessions';

const TOKEN_DAYS = 7;

/**
 * Link de convite (primeira senha) ou de redefinição de senha. O token vai depois do "#",
 * então não aparece em registros de servidor nem é enviado para outros sites.
 */
export async function createPasswordLink(
  db: Db,
  userId: string,
  purpose: 'convite' | 'redefinir',
  createdBy: string | null,
  appUrl: string,
): Promise<InviteLink> {
  // Um link novo invalida os anteriores que ainda não foram usados.
  await db
    .updateTable('password_tokens')
    .set({ used_at: sql`now()` })
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .execute();
  const token = newToken();
  const expiresAt = new Date(Date.now() + TOKEN_DAYS * 86_400_000);
  await db
    .insertInto('password_tokens')
    .values({ id: hashToken(token), user_id: userId, purpose, created_by: createdBy, expires_at: expiresAt })
    .execute();
  return { url: `${appUrl}/definir-senha#token=${token}`, expiresAt: expiresAt.toISOString() };
}

async function findValid(db: Db, token: string) {
  if (!token || token.length > 200) return null;
  return db
    .selectFrom('password_tokens as t')
    .innerJoin('users as u', 'u.id', 't.user_id')
    .select(['t.id', 't.purpose', 'u.id as user_id', 'u.name', 'u.email', 'u.active'])
    .where('t.id', '=', hashToken(token))
    .where('t.used_at', 'is', null)
    .where('t.expires_at', '>', new Date())
    .executeTakeFirst();
}

export async function peekPasswordToken(db: Db, token: string) {
  const t = await findValid(db, token);
  if (!t?.active) return null;
  return { purpose: t.purpose, name: t.name, email: t.email };
}

/** Define a senha usando o link. Encerra as outras sessões do usuário. */
export async function usePasswordToken(db: Db, token: string, password: string) {
  return db.transaction().execute(async (trx) => {
    const t = await findValid(trx, token);
    if (!t?.active) throw badRequest('Este link expirou ou já foi usado. Peça um novo ao gestor.');
    const problem = passwordProblem(password, { email: t.email, name: t.name });
    if (problem) throw badRequest(problem);
    const used = await trx
      .updateTable('password_tokens')
      .set({ used_at: sql`now()` })
      .where('id', '=', t.id)
      .where('used_at', 'is', null)
      .executeTakeFirst();
    if (!Number(used.numUpdatedRows)) throw badRequest('Este link já foi usado.');
    await trx
      .updateTable('users')
      .set({
        password_hash: await hashPassword(password),
        password_changed_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where('id', '=', t.user_id)
      .execute();
    await destroyUserSessions(trx, t.user_id);
    return { userId: t.user_id, purpose: t.purpose };
  });
}
