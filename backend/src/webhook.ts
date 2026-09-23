// Recebe os eventos da Evolution. Só aceita chamadas com o token secreto.
import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { config } from './config.ts';
import { prisma } from './db.ts';
import { scheduleHistoryImport } from './history.ts';
import { enqueue } from './queue.ts';
import { saveMessage, updateMessageStatus, upsertInstance } from './store.ts';
import type { WaMessage } from './whatsapp.ts';

const digest = (value: string) => createHash('sha256').update(value).digest();

function isValidToken(token: string | undefined): boolean {
  return !!token && timingSafeEqual(digest(token), digest(config.webhookToken));
}

export const webhookRouter = Router();

webhookRouter.post('/evolution', express.json({ limit: '50mb' }), async (req, res) => {
  // 401 não é repetido pela Evolution; 500 é (até 10 tentativas).
  if (!isValidToken(req.get('x-webhook-token'))) {
    res.sendStatus(401);
    return;
  }
  const { event, instance, data } = req.body ?? {};
  if (typeof event !== 'string' || typeof instance !== 'string') {
    res.sendStatus(400);
    return;
  }
  try {
    await handleEvent(event, instance, data);
    res.sendStatus(200);
  } catch (error) {
    console.error(`[webhook] erro ao processar ${event} de ${instance}:`, error);
    res.sendStatus(500);
  }
});

async function handleEvent(event: string, instanceName: string, data: any): Promise<void> {
  switch (event) {
    case 'messages.upsert': // recebida, ou enviada pelo celular
    case 'send.message': // enviada pelo sistema
      for (const message of (Array.isArray(data) ? data : [data]) as WaMessage[]) {
        await enqueue(() => saveMessage(instanceName, message, { live: true }));
      }
      return;
    case 'messages.update':
      if (data?.keyId && data?.status) {
        await enqueue(() => updateMessageStatus(instanceName, data.keyId, data.status));
      }
      return;
    case 'messages.set':
      scheduleHistoryImport(instanceName);
      return;
    case 'connection.update':
      if (data?.state) {
        const before = await prisma.instance.findUnique({ where: { name: instanceName } });
        await enqueue(() => upsertInstance(instanceName, { status: data.state, phoneJid: data.wuid }));
        if (before?.status !== data.state) console.log(`[conexão] ${instanceName}: ${data.state}`);
      }
      return;
    default:
      // qrcode.updated: usado na Fase 5 (tela de números).
      return;
  }
}
