import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { apiRouter } from './api.ts';
import { config } from './config.ts';
import { prisma } from './db.ts';
import { startInstanceSync } from './instances.ts';
import { webhookRouter } from './webhook.ts';

const app = express();
app.disable('x-powered-by');
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});
app.use('/webhook', webhookRouter);
app.use('/api', apiRouter);

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

function shutdown(signal: string) {
  console.log(`Encerrando (${signal})...`);
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
