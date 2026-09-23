// API usada pelo frontend: números, conversas, mensagens e envio de texto.
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { prisma } from './db.ts';
import { evolution, EvolutionError } from './evolution.ts';
import type { Instance, Prisma } from './generated/prisma/client.ts';
import { importHistory } from './history.ts';
import { enqueue } from './queue.ts';
import { saveMessage, upsertInstance } from './store.ts';

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function parseId(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'ID inválido');
  return id;
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, max) : fallback;
}

const phoneOf = (jid: string | null) => (jid ? jid.split('@')[0] : null);

export const apiRouter = Router();
apiRouter.use(express.json({ limit: '1mb' }));

apiRouter.get('/instances', async (_req, res) => {
  const instances = await prisma.instance.findMany({ orderBy: { name: 'asc' } });
  res.json(instances.map((i) => ({ id: i.id, name: i.name, nickname: i.nickname, phone: phoneOf(i.phoneJid), status: i.status })));
});

// Lista de conversas, da mais recente para a mais antiga.
// ?tab=responderam|todas  ?instanceId=3  ?cursor=<id da última conversa recebida>  ?limit=50
apiRouter.get('/conversations', async (req, res) => {
  const where: Prisma.ConversationWhereInput = {};
  if (req.query.tab === 'responderam') where.leadReplied = true;
  if (req.query.instanceId) where.instanceId = parseId(req.query.instanceId);
  const limit = parseLimit(req.query.limit, 50, 200);
  const cursor = req.query.cursor ? parseId(req.query.cursor) : undefined;

  const conversations = await prisma.conversation.findMany({
    where,
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    include: { contact: true, instance: true },
  });

  res.json(
    conversations.map((c) => ({
      id: c.id,
      unreadCount: c.unreadCount,
      leadReplied: c.leadReplied,
      lastMessageAt: c.lastMessageAt,
      lastMessagePreview: c.lastMessagePreview,
      lastMessageFromMe: c.lastMessageFromMe,
      contact: { id: c.contact.id, name: c.contact.name, phone: phoneOf(c.contact.phoneJid) },
      instance: { id: c.instance.id, name: c.instance.name, nickname: c.instance.nickname },
    })),
  );
});

// Mensagens de uma conversa, em ordem cronológica. ?before=<id da mensagem mais antiga já carregada>
apiRouter.get('/conversations/:id/messages', async (req, res) => {
  const conversationId = parseId(req.params.id);
  const limit = parseLimit(req.query.limit, 50, 200);
  const before = req.query.before ? parseId(req.query.before) : undefined;

  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(before && { cursor: { id: before }, skip: 1 }),
  });
  res.json(messages.reverse().map(({ instanceId, remoteJid, ...m }) => m));
});

// Zera o contador de não lidas no sistema (não manda tique azul para o lead).
apiRouter.post('/conversations/:id/read', async (req, res) => {
  const id = parseId(req.params.id);
  const { count } = await prisma.conversation.updateMany({ where: { id }, data: { unreadCount: 0 } });
  if (!count) throw new HttpError(404, 'Conversa não encontrada');
  res.sendStatus(204);
});

// Envia texto pelo mesmo número da conversa.
apiRouter.post('/conversations/:id/messages', async (req, res) => {
  const id = parseId(req.params.id);
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) throw new HttpError(400, 'Mensagem vazia');

  const conversation = await prisma.conversation.findUnique({ where: { id }, include: { contact: true, instance: true } });
  if (!conversation) throw new HttpError(404, 'Conversa não encontrada');
  const number = conversation.contact.phoneJid ?? conversation.contact.lidJid;
  if (!number) throw new HttpError(400, 'Contato sem número');

  await ensureConnected(conversation.instance);

  let sent;
  try {
    sent = await evolution.sendText(conversation.instance.name, number, text);
  } catch (error) {
    if (error instanceof EvolutionError) {
      console.error('[envio]', error.message);
      throw new HttpError(502, `Não foi possível enviar: ${error.reason}`);
    }
    throw error;
  }

  // O webhook de confirmação pode chegar antes desta linha; nesse caso a mensagem já está salva.
  const saved = await enqueue(() => saveMessage(conversation.instance.name, sent, { live: true, conversationId: conversation.id }));
  const message =
    saved?.message ??
    (await prisma.message.findUniqueOrThrow({
      where: { instanceId_waId: { instanceId: conversation.instanceId, waId: sent.key.id } },
    }));

  markRepliedAsRead(conversation.instance.name, conversation.id, conversation.contact.phoneJid, message.id).catch((error) =>
    console.error(`[envio] não foi possível marcar como lida a conversa ${conversation.id}:`, (error as Error).message),
  );

  const { instanceId, remoteJid, ...body } = message;
  res.status(201).json(body);
});

// Confere se o número está conectado antes de enviar. Se o status salvo não for "open", confirma na hora com a Evolution.
async function ensureConnected(instance: Instance): Promise<void> {
  if (instance.status === 'open') return;
  const { instance: current } = await evolution.connectionState(instance.name);
  await upsertInstance(instance.name, { status: current.state });
  if (current.state !== 'open') throw new HttpError(409, `O número ${instance.nickname ?? instance.name} está desconectado`);
}

// Ao responder, marca como lidas no WhatsApp as mensagens do lead que estavam sem resposta.
async function markRepliedAsRead(instanceName: string, conversationId: number, phoneJid: string | null, replyId: number) {
  if (!phoneJid) return; // a Evolution só marca como lida pelo telefone
  const previousReply = await prisma.message.findFirst({
    where: { conversationId, fromMe: true, id: { not: replyId } },
    orderBy: { sentAt: 'desc' },
  });
  const unanswered = await prisma.message.findMany({
    where: { conversationId, fromMe: false, ...(previousReply && { sentAt: { gt: previousReply.sentAt } }) },
    orderBy: { sentAt: 'desc' },
    take: 50,
  });
  if (!unanswered.length) return;
  await evolution.markAsRead(
    instanceName,
    unanswered.map((m) => ({ remoteJid: phoneJid, fromMe: false, id: m.waId })),
  );
}

// Reimporta o histórico recente de um número (ferramenta de manutenção).
apiRouter.post('/instances/:name/import-history', async (req, res) => {
  const name = String(req.params.name);
  if (!(await prisma.instance.findUnique({ where: { name } }))) throw new HttpError(404, 'Número não encontrado');
  res.json(await importHistory(name));
});

apiRouter.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof HttpError ? error.status : 500;
  if (status === 500) console.error('[api]', error);
  res.status(status).json({ error: status === 500 ? 'Erro interno' : error.message });
});
