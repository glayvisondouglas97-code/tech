import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES } from '../../shared/conversations';
import { requirePermission, requireUser } from '../http/auth-hooks';
import { parse } from '../http/validation';
import { audit } from '../lib/audit';
import { AppError, badRequest, notFound } from '../lib/errors';
import { conversationDto, conversationsQuery, instanceDto, messageDto } from '../modules/whatsapp/dto';
import { evolution } from '../modules/whatsapp/evolution';
import { importHistory } from '../modules/whatsapp/history';
import { nextInstanceName } from '../modules/whatsapp/instances';
import { baseMime, ensureMedia, isInline, isMediaMessage, mediaFile } from '../modules/whatsapp/media';
import { evolutionFailure, sendToConversation } from '../modules/whatsapp/messaging';
import { publishConversation, publishInstance } from '../modules/whatsapp/realtime';
import { upsertInstance } from '../modules/whatsapp/store';

// Barras e caracteres de controle não entram no nome do arquivo enviado.
// biome-ignore lint/suspicious/noControlCharactersInRegex: é justamente o que a expressão remove.
const UNSAFE_FILE_NAME_CHARS = /[\\/\u0000-\u001f]/g;

const idSchema = z.coerce.number().int().positive();
const parseId = (value: unknown) => parse(idSchema, value);
const nicknameSchema = z
  .string()
  .trim()
  .max(60, 'Apelido muito longo (máximo 60 caracteres)')
  .nullish()
  .transform((v) => v || null);

/** Escapa % e _ para usar o texto da busca dentro de um LIKE. */
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function whatsappRoutes(app: FastifyInstance) {
  const db = app.db;

  // ---------- números ----------
  app.get('/instances', async (req) => {
    requireUser(req);
    const rows = await db.selectFrom('wa_instances').selectAll().orderBy('name').execute();
    return rows.map(instanceDto);
  });

  // Cria um número novo na Evolution, já com webhook e opções. Depois a tela pede o QR Code.
  app.post('/instances', async (req, reply) => {
    const user = requirePermission(req, 'manageNumbers');
    const { nickname } = parse(z.object({ nickname: nicknameSchema }), req.body ?? {});
    if (!nickname) throw badRequest('Informe um apelido, ex.: "WhatsApp 3 - João".');
    const name = await nextInstanceName(db).catch((e) =>
      evolutionFailure(e, 'Não foi possível criar o número'),
    );
    await evolution.createInstance(name).catch((e) => evolutionFailure(e, 'Não foi possível criar o número'));
    await upsertInstance(db, name, { status: 'close' });
    const instance = await db
      .updateTable('wa_instances')
      .set({ nickname, updated_at: sql`now()` })
      .where('name', '=', name)
      .returningAll()
      .executeTakeFirstOrThrow();
    publishInstance(instance);
    await audit(db, {
      userId: user.id,
      action: 'criou_numero',
      entity: 'numero',
      entityId: name,
      details: { apelido: nickname },
      ip: req.ip,
    });
    return reply.status(201).send(instanceDto(instance));
  });

  // Troca o apelido exibido. Vazio volta a mostrar o nome técnico.
  app.patch('/instances/:id', async (req) => {
    const user = requirePermission(req, 'manageNumbers');
    const id = parseId((req.params as { id: string }).id);
    const { nickname } = parse(z.object({ nickname: nicknameSchema }), req.body ?? {});
    const instance = await db
      .updateTable('wa_instances')
      .set({ nickname, updated_at: sql`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!instance) throw notFound('Número não encontrado.');
    publishInstance(instance);
    await audit(db, {
      userId: user.id,
      action: 'renomeou_numero',
      entity: 'numero',
      entityId: instance.name,
      details: { apelido: nickname },
      ip: req.ip,
    });
    return instanceDto(instance);
  });

  // Conecta ou reconecta um número. Se o WhatsApp pedir, os QR Codes chegam pelo tempo real (instance:qrcode).
  app.post('/instances/:id/connect', async (req) => {
    const user = requirePermission(req, 'manageNumbers');
    const id = parseId((req.params as { id: string }).id);
    const instance = await db.selectFrom('wa_instances').selectAll().where('id', '=', id).executeTakeFirst();
    if (!instance) throw notFound('Número não encontrado.');
    const result = await evolution
      .connect(instance.name)
      .catch((e) => evolutionFailure(e, 'Não foi possível conectar'));
    await audit(db, {
      userId: user.id,
      action: 'conectou_numero',
      entity: 'numero',
      entityId: instance.name,
      ip: req.ip,
    });
    if (result.instance?.state === 'open') {
      await upsertInstance(db, instance.name, { status: 'open' });
      return { status: 'open', qrcode: null };
    }
    return { status: 'connecting', qrcode: result.base64 ?? null };
  });

  // Reimporta o histórico recente de um número (ferramenta de manutenção).
  app.post('/instances/:id/import-history', async (req) => {
    requirePermission(req, 'manageNumbers');
    const id = parseId((req.params as { id: string }).id);
    const instance = await db
      .selectFrom('wa_instances')
      .select('name')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!instance) throw notFound('Número não encontrado.');
    return importHistory(db, instance.name).catch((e) => evolutionFailure(e, 'Não foi possível importar'));
  });

  // ---------- conversas ----------

  // Lista de conversas, da mais recente para a mais antiga.
  // ?tab=responderam|todas  ?instanceId=3  ?q=maria  ?cursor=<id da última conversa recebida>  ?limit=50
  app.get('/conversations', async (req) => {
    requireUser(req);
    const q = parse(
      z.object({
        tab: z.enum(['responderam', 'todas']).default('todas'),
        instanceId: idSchema.optional(),
        q: z.string().trim().max(60).optional(),
        cursor: idSchema.optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    let query = conversationsQuery(db);
    if (q.tab === 'responderam') query = query.where('c.lead_replied', '=', true);
    if (q.instanceId) query = query.where('c.instance_id', '=', q.instanceId);
    if (q.q) {
      const text = `%${likeEscape(q.q)}%`;
      const digits = q.q.replace(/\D/g, '');
      query = query.where((eb) =>
        eb.or([
          eb('ct.name', 'ilike', text),
          ...(digits.length >= 3 ? [eb('ct.phone_jid', 'like', `%${digits}%`)] : []),
        ]),
      );
    }
    if (q.cursor) {
      query = query.where(
        sql<boolean>`(c.last_message_at, c.id) < (SELECT last_message_at, id FROM wa_conversations WHERE id = ${q.cursor})`,
      );
    }
    const rows = await query
      .orderBy('c.last_message_at', 'desc')
      .orderBy('c.id', 'desc')
      .limit(q.limit)
      .execute();
    return rows.map(conversationDto);
  });

  // Números para os selos do menu: conversas com mensagens não lidas e números desconectados.
  app.get('/conversations/stats', async (req) => {
    requireUser(req);
    const [unread, disconnected] = await Promise.all([
      db
        .selectFrom('wa_conversations')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('unread_count', '>', 0)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('wa_instances')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('status', '<>', 'open')
        .executeTakeFirstOrThrow(),
    ]);
    return { unreadConversations: Number(unread.n), disconnectedInstances: Number(disconnected.n) };
  });

  app.get('/conversations/:id', async (req) => {
    requireUser(req);
    const id = parseId((req.params as { id: string }).id);
    const row = await conversationsQuery(db).where('c.id', '=', id).executeTakeFirst();
    if (!row) throw notFound('Conversa não encontrada.');
    return conversationDto(row);
  });

  // Mensagens de uma conversa, em ordem cronológica. ?before=<id da mensagem mais antiga já carregada>
  app.get('/conversations/:id/messages', async (req) => {
    requireUser(req);
    const id = parseId((req.params as { id: string }).id);
    const q = parse(
      z.object({
        before: idSchema.optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    let query = db.selectFrom('wa_messages').selectAll().where('conversation_id', '=', id);
    if (q.before) {
      query = query.where(
        sql<boolean>`(sent_at, id) < (SELECT sent_at, id FROM wa_messages WHERE id = ${q.before})`,
      );
    }
    const rows = await query.orderBy('sent_at', 'desc').orderBy('id', 'desc').limit(q.limit).execute();
    return rows.reverse().map(messageDto);
  });

  // Zera o contador de não lidas no sistema (não manda tique azul para o contato).
  app.post('/conversations/:id/read', async (req, reply) => {
    requireUser(req);
    const id = parseId((req.params as { id: string }).id);
    const r = await db
      .updateTable('wa_conversations')
      .set({ unread_count: 0 })
      .where('id', '=', id)
      .executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('Conversa não encontrada.');
    await publishConversation(id);
    return reply.status(204).send();
  });

  // Envia texto pelo mesmo número da conversa.
  app.post('/conversations/:id/messages', async (req, reply) => {
    const user = requireUser(req);
    const id = parseId((req.params as { id: string }).id);
    const { text } = parse(
      z.object({ text: z.string().trim().min(1, 'Mensagem vazia').max(4096) }),
      req.body,
    );
    const message = await sendToConversation(db, id, user.id, (instance, number) =>
      evolution.sendText(instance, number, text),
    );
    return reply.status(201).send(messageDto(message));
  });

  // Arquivos chegam como o próprio corpo da requisição (sem formulário), com o tipo no Content-Type.
  await app.register(async (uploads) => {
    uploads.removeAllContentTypeParsers();
    uploads.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
      (_req, body, done) => done(null, body),
    );

    const uploadedFile = (req: FastifyRequest) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest('Arquivo vazio.');
      return { data: req.body, mime: baseMime(req.headers['content-type']) || 'application/octet-stream' };
    };

    // Áudio gravado no navegador (WebM/MP4). Sai como mensagem de voz: a Evolution converte para OGG/Opus.
    uploads.post('/conversations/:id/audio', { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
      const user = requireUser(req);
      const id = parseId((req.params as { id: string }).id);
      const file = uploadedFile(req);
      if (!file.mime.startsWith('audio/')) throw badRequest('Formato de áudio inválido.');
      const message = await sendToConversation(
        db,
        id,
        user.id,
        (instance, number) => evolution.sendAudio(instance, number, file.data.toString('base64')),
        file,
      );
      return reply.status(201).send(messageDto(message));
    });

    // Imagem (JPEG/PNG/WebP) ou qualquer outro arquivo, como documento. ?fileName=...&caption=...
    uploads.post('/conversations/:id/media', { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
      const user = requireUser(req);
      const id = parseId((req.params as { id: string }).id);
      const file = uploadedFile(req);
      const query = req.query as { fileName?: string; caption?: string };
      const fileName =
        String(query.fileName ?? '')
          .replace(UNSAFE_FILE_NAME_CHARS, '')
          .slice(0, 200) || 'arquivo';
      const caption =
        typeof query.caption === 'string' ? query.caption.trim().slice(0, 1000) || undefined : undefined;
      const mediatype = /^image\/(jpeg|png|webp)$/.test(file.mime) ? 'image' : 'document';
      const message = await sendToConversation(
        db,
        id,
        user.id,
        (instance, number) =>
          evolution.sendMedia(instance, number, {
            mediatype,
            mimetype: file.mime,
            fileName,
            caption,
            base64: file.data.toString('base64'),
          }),
        file,
      );
      return reply.status(201).send(messageDto(message));
    });
  });

  // Abre a mídia de uma mensagem. Se ainda não estiver no disco, baixa pela Evolution primeiro.
  app.get('/messages/:id/media', async (req, reply) => {
    requireUser(req);
    const id = parseId((req.params as { id: string }).id);
    const message = await db.selectFrom('wa_messages').selectAll().where('id', '=', id).executeTakeFirst();
    if (!message || !isMediaMessage(message)) throw notFound('Mídia não encontrada.');
    let stored: typeof message;
    try {
      stored = await ensureMedia(db, message);
    } catch (error) {
      console.error(`[mídia] mensagem ${message.id}:`, (error as Error).message);
      throw new AppError(502, 'Mídia indisponível.', 'whatsapp');
    }
    const file = mediaFile(stored);
    if (!file) throw notFound('Mídia não encontrada.');
    return sendFile(req, reply, file, stored.media_mime ?? 'application/octet-stream', stored.file_name);
  });
}

/** Envia o arquivo com suporte a "Range" (o player de áudio e vídeo pede pedaços para saber a duração). */
async function sendFile(
  req: FastifyRequest,
  reply: FastifyReply,
  file: string,
  mime: string,
  fileName: string | null,
) {
  const { size } = await stat(file);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
  reply.header('Cache-Control', 'private, max-age=31536000, immutable');
  reply.header('Accept-Ranges', 'bytes');
  if (!isInline(mime)) {
    const name = (fileName ?? 'arquivo').replace(/["\\\r\n]/g, '');
    const ascii = name.replace(/[^\x20-\x7e]/g, '_');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
  }
  reply.type(mime);
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && size > 0 && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) {
      reply.header('Content-Range', `bytes */${size}`);
      return reply.status(416).send();
    }
    reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
    reply.header('Content-Length', end - start + 1);
    return reply.status(206).send(createReadStream(file, { start, end }));
  }
  reply.header('Content-Length', size);
  return reply.send(createReadStream(file));
}
