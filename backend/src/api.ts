// API usada pelo frontend: números, conversas, mensagens e envio de texto.
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { prisma } from './db.ts';
import { evolution, EvolutionError } from './evolution.ts';
import { conversationDto, instanceDto, messageDto } from './dto.ts';
import type { Instance, Message, Prisma } from './generated/prisma/client.ts';
import { importHistory } from './history.ts';
import { baseMime, ensureMedia, holdMedia, isInline, isMediaMessage, mediaFile, storeMedia } from './media.ts';
import { enqueue } from './queue.ts';
import { nextInstanceName } from './instances.ts';
import { publishConversation, publishInstance } from './realtime.ts';
import { saveMessage, upsertInstance } from './store.ts';
import type { WaMessage } from './whatsapp.ts';

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

export const apiRouter = Router();
apiRouter.use(express.json({ limit: '1mb' }));

apiRouter.get('/instances', async (_req, res) => {
  const instances = await prisma.instance.findMany({ orderBy: { name: 'asc' } });
  res.json(instances.map(instanceDto));
});

function parseNickname(value: unknown): string | null {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new HttpError(400, 'Apelido inválido');
  const nickname = (value ?? '').trim();
  if (nickname.length > 60) throw new HttpError(400, 'Apelido muito longo (máximo 60 caracteres)');
  return nickname || null;
}

// Cria um número novo na Evolution, já com webhook e opções. Depois a tela pede o QR Code.
apiRouter.post('/instances', async (req, res) => {
  const nickname = parseNickname(req.body?.nickname);
  if (!nickname) throw new HttpError(400, 'Informe um apelido, ex.: "WhatsApp 3 - João"');
  const name = await nextInstanceName();
  try {
    await evolution.createInstance(name);
  } catch (error) {
    if (error instanceof EvolutionError) {
      console.error('[números]', error.message);
      throw new HttpError(502, `Não foi possível criar o número: ${error.reason}`);
    }
    throw error;
  }
  await upsertInstance(name, { status: 'close' });
  const instance = await prisma.instance.update({ where: { name }, data: { nickname } });
  publishInstance(instance);
  console.log(`[números] ${name} criado ("${nickname}")`);
  res.status(201).json(instanceDto(instance));
});

// Troca o apelido exibido. Vazio volta a mostrar o nome técnico.
apiRouter.patch('/instances/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const nickname = parseNickname(req.body?.nickname);
  if (!(await prisma.instance.findUnique({ where: { id } }))) throw new HttpError(404, 'Número não encontrado');
  const instance = await prisma.instance.update({ where: { id }, data: { nickname } });
  publishInstance(instance);
  res.json(instanceDto(instance));
});

// Conecta ou reconecta um número. Se o WhatsApp pedir, os QR Codes chegam pelo tempo real (instance:qrcode).
apiRouter.post('/instances/:id/connect', async (req, res) => {
  const instance = await prisma.instance.findUnique({ where: { id: parseId(req.params.id) } });
  if (!instance) throw new HttpError(404, 'Número não encontrado');
  let result;
  try {
    result = await evolution.connect(instance.name);
  } catch (error) {
    if (error instanceof EvolutionError) {
      console.error('[números]', error.message);
      throw new HttpError(502, `Não foi possível conectar: ${error.reason}`);
    }
    throw error;
  }
  if (result.instance?.state === 'open') {
    await upsertInstance(instance.name, { status: 'open' });
    res.json({ status: 'open', qrcode: null });
    return;
  }
  res.json({ status: 'connecting', qrcode: result.base64 ?? null });
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
  res.json(conversations.map(conversationDto));
});

apiRouter.get('/conversations/:id', async (req, res) => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: parseId(req.params.id) },
    include: { contact: true, instance: true },
  });
  if (!conversation) throw new HttpError(404, 'Conversa não encontrada');
  res.json(conversationDto(conversation));
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
  res.json(messages.reverse().map(messageDto));
});

// Zera o contador de não lidas no sistema (não manda tique azul para o lead).
apiRouter.post('/conversations/:id/read', async (req, res) => {
  const id = parseId(req.params.id);
  const { count } = await prisma.conversation.updateMany({ where: { id }, data: { unreadCount: 0 } });
  if (!count) throw new HttpError(404, 'Conversa não encontrada');
  await publishConversation(id);
  res.sendStatus(204);
});

// Envia texto pelo mesmo número da conversa.
apiRouter.post('/conversations/:id/messages', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) throw new HttpError(400, 'Mensagem vazia');
  const message = await sendToConversation(parseId(req.params.id), (instance, number) => evolution.sendText(instance, number, text));
  res.status(201).json(messageDto(message));
});

// Arquivos chegam como o próprio corpo da requisição (sem formulário), com o tipo no Content-Type.
const MAX_UPLOAD = '25mb';
const rawBody = express.raw({ type: () => true, limit: MAX_UPLOAD });

function uploadedFile(req: Request): { data: Buffer; mime: string } {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Arquivo vazio');
  return { data: req.body, mime: baseMime(req.get('content-type')) || 'application/octet-stream' };
}

// Áudio gravado no navegador (WebM/MP4). Sai como mensagem de voz: a Evolution converte para OGG/Opus.
apiRouter.post('/conversations/:id/audio', rawBody, async (req, res) => {
  const file = uploadedFile(req);
  if (!file.mime.startsWith('audio/')) throw new HttpError(400, 'Formato de áudio inválido');
  const message = await sendToConversation(
    parseId(req.params.id),
    (instance, number) => evolution.sendAudio(instance, number, file.data.toString('base64')),
    file,
  );
  res.status(201).json(messageDto(message));
});

// Imagem (JPEG/PNG/WebP) ou qualquer outro arquivo, como documento. ?fileName=...&caption=...
apiRouter.post('/conversations/:id/media', rawBody, async (req, res) => {
  const file = uploadedFile(req);
  const fileName = String(req.query.fileName ?? '').replace(/[\\/\u0000-\u001f]/g, '').slice(0, 200) || 'arquivo';
  const caption = typeof req.query.caption === 'string' ? req.query.caption.trim().slice(0, 1000) || undefined : undefined;
  const mediatype = /^image\/(jpeg|png|webp)$/.test(file.mime) ? 'image' : 'document';
  const message = await sendToConversation(
    parseId(req.params.id),
    (instance, number) =>
      evolution.sendMedia(instance, number, { mediatype, mimetype: file.mime, fileName, caption, base64: file.data.toString('base64') }),
    file,
  );
  res.status(201).json(messageDto(message));
});

// Abre a mídia de uma mensagem. Se ainda não estiver no disco, baixa pela Evolution primeiro.
apiRouter.get('/messages/:id/media', async (req, res) => {
  const message = await prisma.message.findUnique({ where: { id: parseId(req.params.id) } });
  if (!message || !isMediaMessage(message)) throw new HttpError(404, 'Mídia não encontrada');
  let stored;
  try {
    stored = await ensureMedia(message);
  } catch (error) {
    console.error(`[mídia] mensagem ${message.id}:`, (error as Error).message);
    throw new HttpError(502, 'Mídia indisponível');
  }
  const mime = stored.mediaMime ?? 'application/octet-stream';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  if (!isInline(mime)) res.attachment(stored.fileName ?? 'arquivo');
  res.type(mime);
  res.sendFile(mediaFile(stored)!);
});

// Envia pelo mesmo número da conversa, grava a mensagem (e o arquivo, se houver) e marca como lidas
// no WhatsApp as mensagens do lead que foram respondidas.
async function sendToConversation(
  conversationId: number,
  send: (instanceName: string, number: string) => Promise<WaMessage>,
  media?: { data: Buffer; mime: string },
): Promise<Message> {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true, instance: true } });
  if (!conversation) throw new HttpError(404, 'Conversa não encontrada');
  const number = conversation.contact.phoneJid ?? conversation.contact.lidJid;
  if (!number) throw new HttpError(400, 'Contato sem número');

  await ensureConnected(conversation.instance);

  let sent;
  try {
    sent = await send(conversation.instance.name, number);
  } catch (error) {
    if (error instanceof EvolutionError) {
      console.error('[envio]', error.message);
      throw new HttpError(502, `Não foi possível enviar: ${error.reason}`);
    }
    throw error;
  }

  // Se for arquivo, quem pedir a mídia antes da gravação terminar espera por ela (ver holdMedia).
  let stored: { resolve: (m: Message) => void; reject: (e: unknown) => void } | undefined;
  if (media) {
    holdMedia(conversation.instanceId, sent.key.id, new Promise<Message>((resolve, reject) => (stored = { resolve, reject })));
  }
  try {
    // O webhook de confirmação pode chegar antes desta linha; nesse caso a mensagem já está salva.
    const saved = await enqueue(() => saveMessage(conversation.instance.name, sent, { live: true, conversationId: conversation.id }));
    let message =
      saved?.message ??
      (await prisma.message.findUniqueOrThrow({
        where: { instanceId_waId: { instanceId: conversation.instanceId, waId: sent.key.id } },
      }));
    if (media) {
      message = await storeMedia(message, media.data, media.mime);
      stored?.resolve(message);
    }

    markRepliedAsRead(conversation.instance.name, conversation.id, conversation.contact.phoneJid, message.id).catch((error) =>
      console.error(`[envio] não foi possível marcar como lida a conversa ${conversation.id}:`, (error as Error).message),
    );
    return message;
  } catch (error) {
    stored?.reject(error);
    throw error;
  }
}

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
  if ((error as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: `Arquivo muito grande (máximo ${MAX_UPLOAD.replace('mb', ' MB')})` });
    return;
  }
  const status = error instanceof HttpError ? error.status : 500;
  if (status === 500) console.error('[api]', error);
  res.status(status).json({ error: status === 500 ? 'Erro interno' : error.message });
});
