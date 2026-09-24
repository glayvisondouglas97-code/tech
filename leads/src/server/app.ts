import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { LoginLimiter } from './auth/login-limiter';
import type { Config } from './config';
import type { Db } from './db';
import { registerAuthHooks } from './http/auth-hooks';
import { audit } from './lib/audit';
import { AppError } from './lib/errors';
import { MAX_FILE_BYTES } from './modules/imports/service';
import { registerRoutes } from './routes';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    loginLimiter: LoginLimiter;
    appOptions: AppOptions;
  }
}

export interface AppOptions {
  /** Tentativas de login por IP a cada 15 minutos. */
  loginAttemptsPerIp?: number;
  /** Requisições por minuto por usuário (ou IP, sem login). */
  requestsPerMinute?: number;
  logger?: boolean | object;
}

export async function buildApp(db: Db, config: Config, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
  });
  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('loginLimiter', new LoginLimiter());
  app.decorate('appOptions', opts);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.APP_URL.startsWith('https://') ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    // Os links do WhatsApp (wa.me) abrem com noopener: a janela do sistema fica isolada.
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.APP_URL.startsWith('https://') ? { maxAge: 31536000 } : false,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10 } });

  registerAuthHooks(app);

  await app.register(rateLimit, {
    global: true,
    hook: 'preHandler',
    max: opts.requestsPerMinute ?? 600,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.auth?.user.id ?? req.ip,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: `Muitas requisições seguidas. Espere ${Math.ceil(ctx.ttl / 1000)} segundos e tente de novo.`,
      code: 'muitas_requisicoes',
    }),
  });

  app.setErrorHandler(
    (err: Error & { statusCode?: number; code?: string; validation?: unknown }, req, reply) => {
      if (err instanceof AppError) {
        // Tentativa de acessar algo sem permissão fica na auditoria (nada passa despercebido).
        if (err.statusCode === 403 && req.auth) {
          void audit(db, {
            userId: req.auth.user.id,
            action: 'acesso_negado',
            details: { rota: req.routeOptions.url ?? req.url, metodo: req.method },
            ip: req.ip,
          }).catch(() => {});
        }
        return reply.status(err.statusCode).send({ error: err.message, code: err.code, ...err.details });
      }
      if (err.code === 'FST_REQ_FILE_TOO_LARGE' || err.code === 'FST_FILES_LIMIT') {
        return reply
          .status(413)
          .send({ error: 'Arquivo grande demais (máximo 25 MB).', code: 'arquivo_grande' });
      }
      if (err.statusCode === 429) {
        return reply.status(429).send({ error: err.message, code: 'muitas_requisicoes' });
      }
      if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
        return reply.status(err.statusCode).send({
          error: err.statusCode === 415 ? 'Formato de envio não aceito.' : 'Requisição inválida.',
          code: 'requisicao_invalida',
        });
      }
      req.log.error({ err }, 'erro inesperado');
      return reply.status(500).send({
        error: 'Erro inesperado no servidor. Tente de novo; se continuar, avise o responsável pelo sistema.',
        code: 'erro_interno',
      });
    },
  );

  await app.register(registerRoutes, { prefix: '/api' });

  // Front-end compilado (produção). Em desenvolvimento, o Vite serve a interface.
  const webDist = config.WEB_DIST;
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      index: false,
      setHeaders: (reply, path) => {
        if (/[\\/]assets[\\/]/.test(path))
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        else reply.header('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') {
        return reply.status(404).send({ error: 'Não encontrado.', code: 'nao_encontrado' });
      }
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) =>
      reply.status(404).send({ error: 'Não encontrado.', code: 'nao_encontrado' }),
    );
  }

  return app;
}
