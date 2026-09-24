import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { can } from '../../shared/roles';
import { type AuthUser, type LoadedSession, loadSession } from '../auth/sessions';
import { isSecureUrl } from '../config';
import { forbidden, unauthorized } from '../lib/errors';

declare module 'fastify' {
  interface FastifyRequest {
    auth: LoadedSession | null;
  }
  interface FastifyContextConfig {
    /** false = rota sem token CSRF (login e telas sem sessão). A origem continua sendo conferida. */
    csrf?: boolean;
    /** true = chamada de servidor externo (webhook), sem conferência de origem nem de CSRF. */
    webhook?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function sessionCookieName(app: FastifyInstance): string {
  // O prefixo __Host- obriga o navegador a só aceitar o cookie via HTTPS, no domínio exato.
  return isSecureUrl(app.config) ? '__Host-cl_sid' : 'cl_sid';
}

export function setSessionCookie(app: FastifyInstance, reply: FastifyReply, token: string): void {
  reply.setCookie(sessionCookieName(app), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureUrl(app.config),
    path: '/',
    maxAge: 30 * 86_400,
  });
}

export function clearSessionCookie(app: FastifyInstance, reply: FastifyReply): void {
  reply.clearCookie(sessionCookieName(app), { path: '/', secure: isSecureUrl(app.config), sameSite: 'lax' });
}

export function registerAuthHooks(app: FastifyInstance): void {
  app.decorateRequest('auth', null);
  const cookieName = sessionCookieName(app);
  const appOrigin = new URL(app.config.APP_URL).origin;

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const token = req.cookies[cookieName];
    req.auth = token ? await loadSession(app.db, token) : null;
  });

  // CSRF: toda requisição que altera dados precisa do cabeçalho X-CSRF-Token da sessão,
  // e a origem (quando o navegador informa) precisa ser o próprio sistema.
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || SAFE_METHODS.has(req.method)) return;
    const config = req.routeOptions.config;
    if (config?.webhook) return;
    const origin = req.headers.origin;
    // Compara só o domínio: atrás do proxy da hospedagem o esquema interno pode ser http.
    const originHost = origin ? URL.parse(origin)?.host : null;
    if (origin && origin !== appOrigin && originHost !== req.host) {
      throw forbidden('Origem da requisição não permitida.');
    }
    if (config?.csrf === false) return;
    if (req.auth && req.headers['x-csrf-token'] !== req.auth.csrfToken) {
      throw forbidden('Sua sessão ficou desatualizada. Recarregue a página.');
    }
  });
}

/** Exige login. Devolve o usuário logado. */
export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.auth) throw unauthorized();
  return req.auth.user;
}

/** Exige login e a permissão indicada (tabela em src/shared/roles.ts). */
export function requirePermission(req: FastifyRequest, permission: keyof typeof can): AuthUser {
  const user = requireUser(req);
  if (!can[permission](user.role)) throw forbidden();
  return user;
}
