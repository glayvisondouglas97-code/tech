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

const server = app.listen(config.port, () => {
  console.log(`Backend no ar na porta ${config.port}`);
  startInstanceSync();
});

function shutdown() {
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
