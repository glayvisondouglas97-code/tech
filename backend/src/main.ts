import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { accountsErrorHandler, authRouter } from './accounts.ts';
import { apiRouter } from './api.ts';
import { requireAuth } from './auth.ts';
import { config } from './config.ts';
import { prisma } from './db.ts';
import { startInstanceSync } from './instances.ts';
import { startRealtime } from './realtime.ts';
import { webhookRouter } from './webhook.ts';

const app = express();
app.disable('x-powered-by');
// No VPS, o Caddy (HTTPS) fica na frente e informa o IP real e o protocolo original.
app.set('trust proxy', 'loopback, uniquelocal');
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});
app.use('/webhook', webhookRouter);
app.use('/api', sameOriginOnly);
app.use('/api/auth', authRouter, accountsErrorHandler);
app.use('/api', requireAuth, apiRouter);

// Site (frontend já compilado). No Docker fica em /app/public.
const publicDir = process.env.PUBLIC_DIR ?? fileURLToPath(new URL('../public', import.meta.url));
if (existsSync(publicDir)) app.use(express.static(publicDir));

const server = app.listen(config.port, (error?: Error) => {
  if (error) {
    console.error(`Não foi possível abrir a porta ${config.port}:`, error.message);
    process.exit(1);
  }
  console.log(`Backend no ar na porta ${config.port}`);
  startInstanceSync();
});
startRealtime(server);

function shutdown(signal: string) {
  console.log(`Encerrando (${signal})...`);
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Pedidos que alteram dados só são aceitos vindos do próprio site (proteção extra contra sites falsos).
function sameOriginOnly(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const origin = req.get('origin');
  if (req.method === 'GET' || req.method === 'HEAD' || !origin) return next();
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    // origem inválida: recusa abaixo
  }
  if (originHost !== req.get('host')) {
    res.status(403).json({ error: 'Origem não permitida' });
    return;
  }
  next();
}
