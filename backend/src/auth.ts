// Login da equipe: senhas com scrypt (nativo do Node) e sessões guardadas no banco,
// num cookie HttpOnly (o JavaScript da página não consegue lê-lo).
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from './db.ts';
import type { User } from './generated/prisma/client.ts';

// ---------- Senhas ----------

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scryptAsync(password: string, salt: Buffer, keylen: number, options: typeof SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, N, r, p, salt, hash] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(actual, expected);
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < 8) return 'A senha precisa ter pelo menos 8 caracteres';
  if (password.length > 200) return 'Senha longa demais';
  return null;
}

// Senha provisória fácil de ditar (sem 0/O, 1/l): ex. "k7mp-x3qa-9fzd".
export function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const part = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${part()}-${part()}-${part()}`;
}

export const normalizeEmail = (email: unknown) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

// ---------- Sessões ----------

export const SESSION_COOKIE = 'central_sessao';
const SESSION_DAYS = 30;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function createSession(req: Request, res: Response, userId: number): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }); // limpeza das sessões vencidas
  await prisma.session.create({ data: { tokenHash: sha256(token), userId, expiresAt } });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure, // no VPS (HTTPS pelo Caddy) o cookie só trafega criptografado
    path: '/',
    expires: expiresAt,
  });
}

export async function userFromCookie(cookieHeader: string | undefined): Promise<User | null> {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!session || session.expiresAt < new Date() || !session.user.active) return null;
  return session.user;
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (token) await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

// Encerra os logins de um usuário (ao desativar ou redefinir a senha). Pode manter o login atual.
export async function destroyUserSessions(userId: number, exceptCookieHeader?: string): Promise<void> {
  const keep = readCookie(exceptCookieHeader, SESSION_COOKIE);
  await prisma.session.deleteMany({ where: { userId, ...(keep && { tokenHash: { not: sha256(keep) } }) } });
}

export const currentUser = (res: Response) => res.locals.user as User;

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await userFromCookie(req.headers.cookie);
  if (!user) {
    res.status(401).json({ error: 'Faça login para continuar' });
    return;
  }
  res.locals.user = user;
  next();
}

export function requireAdmin(_req: Request, res: Response, next: NextFunction): void {
  if (!currentUser(res)?.isAdmin) {
    res.status(403).json({ error: 'Só administradores podem fazer isso' });
    return;
  }
  next();
}

export function userDto(u: User) {
  return { id: u.id, name: u.name, email: u.email, isAdmin: u.isAdmin, active: u.active };
}

// ---------- Limite de tentativas de login ----------
// Em 15 minutos: 10 senhas erradas para o mesmo e-mail, ou 30 vindas do mesmo IP, bloqueiam novas tentativas.
// O limite por IP é maior porque a equipe pode estar toda no mesmo escritório (mesmo IP).

const WINDOW_MS = 15 * 60 * 1000;
const maxFailures = (key: string) => (key.startsWith('ip:') ? 30 : 10);
const failures = new Map<string, { count: number; since: number }>();

export function isBlocked(keys: string[]): boolean {
  const now = Date.now();
  return keys.some((key) => {
    const entry = failures.get(key);
    if (entry && now - entry.since > WINDOW_MS) failures.delete(key);
    return (failures.get(key)?.count ?? 0) >= maxFailures(key);
  });
}

export function recordFailure(keys: string[]): void {
  const now = Date.now();
  for (const key of keys) {
    const entry = failures.get(key);
    if (!entry || now - entry.since > WINDOW_MS) failures.set(key, { count: 1, since: now });
    else entry.count++;
  }
}

export function clearFailures(keys: string[]): void {
  for (const key of keys) failures.delete(key);
}
