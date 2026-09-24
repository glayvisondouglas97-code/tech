import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { SessionInfo } from '../../shared/api';
import { fakeVerify, hashPassword, passwordProblem, verifyPassword } from '../auth/password';
import { createSession, destroySession, destroyUserSessions } from '../auth/sessions';
import { peekPasswordToken, usePasswordToken } from '../auth/tokens';
import { clearSessionCookie, requireUser, setSessionCookie } from '../http/auth-hooks';
import { parse } from '../http/validation';
import { audit } from '../lib/audit';
import { badRequest, conflict, forbidden, tooMany, unauthorized } from '../lib/errors';
import { createAdminDirect } from '../modules/users/service';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(200),
  password: z.string().max(200),
});

async function startSession(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<SessionInfo> {
  const { token, csrfToken } = await createSession(app.db, userId, {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  setSessionCookie(app, reply, token);
  await app.db.updateTable('users').set({ last_login_at: sql`now()` }).where('id', '=', userId).execute();
  const u = await app.db
    .selectFrom('users')
    .select(['id', 'name', 'email', 'role'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  return { user: u, csrfToken };
}

export async function authRoutes(app: FastifyInstance) {
  const loginLimit = {
    rateLimit: {
      max: app.appOptions.loginAttemptsPerIp ?? 30,
      timeWindow: '15 minutes',
      keyGenerator: (r: FastifyRequest) => r.ip,
    },
  };

  app.post('/auth/login', { config: { csrf: false, ...loginLimit } }, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const key = body.email;
    const wait = app.loginLimiter.blockedFor(key);
    if (wait)
      throw tooMany(`Muitas tentativas erradas. Tente de novo em ${wait} minuto${wait > 1 ? 's' : ''}.`);

    const user = await app.db
      .selectFrom('users')
      .select(['id', 'name', 'password_hash', 'active'])
      .where(sql`lower(email)`, '=', body.email)
      .executeTakeFirst();
    let ok = false;
    if (user?.password_hash) ok = await verifyPassword(user.password_hash, body.password);
    else await fakeVerify(body.password);
    if (!user || !ok) {
      app.loginLimiter.fail(key);
      await audit(app.db, {
        userId: user?.id ?? null,
        action: 'login_falhou',
        details: user ? {} : { email_desconhecido: true },
        ip: req.ip,
      });
      throw unauthorized('E-mail ou senha incorretos.');
    }
    if (!user.active) throw forbidden('Seu acesso está desativado. Fale com o gestor.');
    app.loginLimiter.reset(key);
    const session = await startSession(app, req, reply, user.id);
    await audit(app.db, { userId: user.id, action: 'login', ip: req.ip });
    return session;
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.auth) {
      await destroySession(app.db, req.auth.sessionId);
      await audit(app.db, { userId: req.auth.user.id, action: 'logout', ip: req.ip });
    }
    clearSessionCookie(app, reply);
    return { ok: true };
  });

  app.get('/auth/me', async (req): Promise<SessionInfo> => {
    const user = requireUser(req);
    return { user, csrfToken: req.auth?.csrfToken ?? '' };
  });

  app.post('/auth/password', async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) }),
      req.body,
    );
    const row = await app.db
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    if (!row.password_hash || !(await verifyPassword(row.password_hash, body.currentPassword))) {
      throw badRequest('A senha atual está errada.');
    }
    const problem = passwordProblem(body.newPassword, { email: user.email, name: user.name });
    if (problem) throw badRequest(problem);
    await app.db
      .updateTable('users')
      .set({
        password_hash: await hashPassword(body.newPassword),
        password_changed_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where('id', '=', user.id)
      .execute();
    await destroyUserSessions(app.db, user.id, req.auth?.sessionId);
    await audit(app.db, { userId: user.id, action: 'trocou_senha', ip: req.ip });
    return { ok: true };
  });

  const tokenSchema = z.object({ token: z.string().min(10).max(200) });

  app.post('/auth/token/info', { config: { csrf: false, ...loginLimit } }, async (req) => {
    const { token } = parse(tokenSchema, req.body);
    const info = await peekPasswordToken(app.db, token);
    if (!info) throw badRequest('Este link expirou ou já foi usado. Peça um novo ao gestor.');
    return info;
  });

  app.post('/auth/token/use', { config: { csrf: false, ...loginLimit } }, async (req, reply) => {
    const body = parse(tokenSchema.extend({ password: z.string().max(200) }), req.body);
    const r = await usePasswordToken(app.db, body.token, body.password);
    await audit(app.db, {
      userId: r.userId,
      action: r.purpose === 'convite' ? 'aceitou_convite' : 'redefiniu_senha',
      ip: req.ip,
    });
    return startSession(app, req, reply, r.userId);
  });

  // ---------- primeiro acesso ----------
  const hasUsers = async () => !!(await app.db.selectFrom('users').select('id').limit(1).executeTakeFirst());

  app.get('/setup', async () => ({ needed: !(await hasUsers()), enabled: !!app.config.SETUP_TOKEN }));

  app.post('/setup', { config: { csrf: false, ...loginLimit } }, async (req, reply) => {
    const body = parse(
      z.object({
        setupToken: z.string().max(200),
        name: z.string().trim().min(1).max(80),
        email: z.string().trim().toLowerCase().email().max(200),
        password: z.string().max(200),
      }),
      req.body,
    );
    const expected = app.config.SETUP_TOKEN;
    if (!expected)
      throw forbidden('O primeiro acesso pela tela está desligado. Use o comando "npm run criar-admin".');
    const a = Buffer.from(body.setupToken);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw forbidden('Código de primeiro acesso incorreto.');
    const problem = passwordProblem(body.password, body);
    if (problem) throw badRequest(problem);
    // Trava para duas pessoas não criarem o primeiro administrador ao mesmo tempo.
    const id = await app.db.transaction().execute(async (trx) => {
      await sql`LOCK TABLE users IN EXCLUSIVE MODE`.execute(trx);
      if (await trx.selectFrom('users').select('id').limit(1).executeTakeFirst()) {
        throw conflict('O sistema já tem um administrador. Entre com e-mail e senha.');
      }
      return createAdminDirect(trx, body);
    });
    return startSession(app, req, reply, id);
  });
}
