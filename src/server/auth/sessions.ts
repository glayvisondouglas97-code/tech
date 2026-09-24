import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { Role } from '../../shared/roles';
import type { Db } from '../db';

/** Sessão expira depois de 7 dias sem uso e, no máximo, 30 dias depois do login. */
export const IDLE_DAYS = 7;
export const ABSOLUTE_DAYS = 30;
const DAY = 86_400_000;

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface LoadedSession {
  sessionId: string;
  csrfToken: string;
  user: AuthUser;
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** No banco fica só o hash do token: quem ler o banco não consegue usar as sessões. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Db,
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; csrfToken: string }> {
  const token = newToken();
  const csrfToken = newToken(24);
  await db
    .insertInto('sessions')
    .values({
      id: hashToken(token),
      user_id: userId,
      csrf_token: csrfToken,
      expires_at: new Date(Date.now() + IDLE_DAYS * DAY),
      ip: meta.ip ?? null,
      user_agent: meta.userAgent?.slice(0, 300) ?? null,
    })
    .execute();
  return { token, csrfToken };
}

export async function loadSession(db: Db, token: string): Promise<LoadedSession | null> {
  if (!token || token.length > 200) return null;
  const id = hashToken(token);
  const row = await db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select([
      's.id',
      's.csrf_token',
      's.created_at',
      's.last_seen_at',
      'u.id as user_id',
      'u.name',
      'u.email',
      'u.role',
    ])
    .where('s.id', '=', id)
    .where('s.expires_at', '>', new Date())
    .where('u.active', '=', true)
    .executeTakeFirst();
  if (!row) return null;

  // Renova a validade no máximo a cada 5 minutos, para não gravar no banco a cada clique.
  if (Date.now() - row.last_seen_at.getTime() > 5 * 60_000) {
    const absoluteEnd = row.created_at.getTime() + ABSOLUTE_DAYS * DAY;
    const newExpiry = new Date(Math.min(Date.now() + IDLE_DAYS * DAY, absoluteEnd));
    await db
      .updateTable('sessions')
      .set({ last_seen_at: sql`now()`, expires_at: newExpiry })
      .where('id', '=', id)
      .execute();
  }
  return {
    sessionId: row.id,
    csrfToken: row.csrf_token,
    user: { id: row.user_id, name: row.name, email: row.email, role: row.role },
  };
}

/** Quem precisa saber quando sessões acabam (o tempo real derruba a conexão delas na hora). */
type SessionsDestroyed = { sessionId?: string; userId?: string; exceptSessionId?: string };
const destroyedListeners: ((e: SessionsDestroyed) => Promise<void> | void)[] = [];

export function onSessionsDestroyed(listener: (e: SessionsDestroyed) => Promise<void> | void): void {
  destroyedListeners.push(listener);
}

function notifyDestroyed(e: SessionsDestroyed): void {
  for (const listener of destroyedListeners) {
    Promise.resolve(listener(e)).catch(() => {});
  }
}

export async function destroySession(db: Db, sessionId: string): Promise<void> {
  await db.deleteFrom('sessions').where('id', '=', sessionId).execute();
  notifyDestroyed({ sessionId });
}

export async function destroyUserSessions(db: Db, userId: string, exceptSessionId?: string): Promise<void> {
  let q = db.deleteFrom('sessions').where('user_id', '=', userId);
  if (exceptSessionId) q = q.where('id', '<>', exceptSessionId);
  await q.execute();
  notifyDestroyed({ userId, exceptSessionId });
}
