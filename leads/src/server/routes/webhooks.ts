import type { FastifyInstance, FastifyRequest } from 'fastify';
import { forbidden, notFound } from '../lib/errors';
import { processWebhook, validSignature } from '../modules/whatsapp/webhook';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/** Webhook da WhatsApp Business Cloud API. Só existe com WHATSAPP_CLOUD_ENABLED=true. */
export async function webhookRoutes(app: FastifyInstance) {
  // O corpo cru é necessário para conferir a assinatura da Meta.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req: FastifyRequest, body: Buffer, done) => {
      req.rawBody = body;
      try {
        done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
      } catch {
        done(Object.assign(new Error('JSON inválido'), { statusCode: 400 }), undefined);
      }
    },
  );

  const enabled = () => {
    if (!app.config.WHATSAPP_CLOUD_ENABLED) throw notFound();
  };

  app.get('/webhooks/whatsapp', { config: { webhook: true } }, async (req, reply) => {
    enabled();
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === app.config.WHATSAPP_VERIFY_TOKEN) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    throw forbidden('Token de verificação inválido.');
  });

  app.post('/webhooks/whatsapp', { config: { webhook: true, rateLimit: false } }, async (req) => {
    enabled();
    const secret = app.config.WHATSAPP_APP_SECRET ?? '';
    if (
      !req.rawBody ||
      !validSignature(secret, req.rawBody, req.headers['x-hub-signature-256'] as string | undefined)
    ) {
      throw forbidden('Assinatura inválida.');
    }
    return processWebhook(app.db, req.body as Parameters<typeof processWebhook>[1]);
  });
}
