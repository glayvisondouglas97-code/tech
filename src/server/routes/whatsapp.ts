import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES } from '../../shared/conversations';
import { can } from '../../shared/roles';
import { requireUser } from '../http/auth-hooks';
import { parse } from '../http/validation';
import { audit } from '../lib/audit';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { leadForChat, parseLeadId } from '../modules/leads/service';
import {
  assertConversationVisible,
  canSeeNumber,
  manageableNumber,
  visibleNumbers,
} from '../modules/whatsapp/access';
import {
  conversationDto,
  conversationsQuery,
  instanceDto,
  instancesQuery,
  messageDto,
} from '../modules/whatsapp/dto';
import { evolution } from '../modules/whatsapp/evolution';
import { importHistory } from '../modules/whatsapp/history';
import { nextInstanceName } from '../modules/whatsapp/instances';
import { startLeadChat } from '../modules/whatsapp/leads';
import { baseMime, ensureMedia, isInline, isMediaMessage, mediaFile } from '../modules/whatsapp/media';
import { evolutionFailure, sendToConversation } from '../modules/whatsapp/messaging';
import { publishConversation, publishInstance, publishOwnerChange } from '../modules/whatsapp/realtime';
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
  // Cada pessoa cadastra e cuida dos próprios números. Dono, administrador e supervisor veem todos;
  // dono e administrador também conectam, renomeiam e trocam o responsável de qualquer um.

  app.get('/instances', async (req) => {
    const user = requireUser(req);
    const rows = await instancesQuery(db).where(visibleNumbers(user)).orderBy('i.name').execute();
    return rows.map(instanceDto);
  });

  const loadDto = async (id: number) =>
    instanceDto(await instancesQuery(db).where('i.id', '=', id).executeTakeFirstOrThrow());

  // Cria um número novo na Evolution, já com webhook e opções. Quem cadastra fica como responsável.
  app.post('/instances', async (req, reply) => {
    const user = requireUser(req);
    const { nickname } = parse(z.object({ nickname: nicknameSchema }), req.body ?? {});
    if (!nickname) throw badRequest('Informe um apelido, ex.: "WhatsApp 3 - João".');
    const name = await nextInstanceName(db).catch((e) =>
      evolutionFailure(e, 'Não foi possível criar o número'),
    );
    await evolution.createInstance(name).catch((e) => evolutionFailure(e, 'Não foi possível criar o número'));
    await upsertInstance(db, name, { status: 'close' });
    const instance = await db
      .updateTable('wa_instances')
      .set({ nickname, owner_id: user.id, updated_at: sql`now()` })
      .where('name', '=', name)
      .returningAll()
      .executeTakeFirstOrThrow();
    await publishOwnerChange(instance.id, null, user.id);
    await audit(db, {
      userId: user.id,
      action: 'criou_numero',
      entity: 'numero',
      entityId: name,
      details: { apelido: nickname },
      ip: req.ip,
    });
    return reply.status(201).send(await loadDto(instance.id));
  });

  // Troca o apelido (vazio volta a mostrar o nome técnico) e, para dono e administrador, o responsável.
  app.patch('/instances/:id', async (req) => {
    const user = requireUser(req);
    const id = parseId((req.params as { id: string }).id);
    const body = parse(
      z.object({
        nickname: z.string().trim().max(60, 'Apelido muito longo (máximo 60 caracteres)').nullish(),
        ownerId: z.string().uuid('Responsável inválido.').nullish(),
      }),
      req.body ?? {},
    );
    const instance = await manageableNumber(db, user, id);
    const changes: { nickname?: string | null; owner_id?: string | null } = {};
    if (body.nickname !== undefined) changes.nickname = body.nickname || null;
    if (body.ownerId !== undefined && body.ownerId !== instance.owner_id) {
      if (!can.manageNumbers(user.role)) {
        throw forbidden('Só o dono ou um administrador troca o responsável de um número.');
      }
      if (body.ownerId) {
        const owner = await db
          .selectFrom('users')
          .select('id')
          .where('id', '=', body.ownerId)
          .where('active', '=', true)
          .executeTakeFirst();
        if (!owner) throw badRequest('Essa pessoa não está ativa na equipe.');
      }
      changes.owner_id = body.ownerId ?? null;
    }
    if (!Object.keys(changes).length) return loadDto(id);

    await db
      .updateTable('wa_instances')
      .set({ ...changes, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
    if (changes.owner_id !== undefined) {
      await publishOwnerChange(id, instance.owner_id, changes.owner_id);
      const names = await db
        .selectFrom('users')
        .select(['id', 'name'])
        .where(
          'id',
          'in',
          [instance.owner_id, changes.owner_id].filter((v): v is string => !!v),
        )
        .execute()
        .then((rows) => new Map(rows.map((r) => [r.id, r.name])));
      await audit(db, {
        userId: user.id,
        action: 'trocou_responsavel_numero',
        entity: 'numero',
        entityId: instance.name,
        details: {
          de: instance.owner_id ? (names.get(instance.owner_id) ?? instance.owner_id) : 'sem responsável',
          para: changes.owner_id ? (names.get(changes.owner_id) ?? changes.owner_id) : 'sem responsável',
        },
        ip: req.ip,
      });
    } else {
      await publishInstance(id);
    }
    if (changes.nickname !== undefined) {
      await audit(db, {
        userId: user.id,
        action: 'renomeou_numero',
        entity: 'numero',
        entityId: instance.name,
        details: { apelido: changes.nickname },
        ip: req.ip,
      });
    }
    return loadDto(id);
  });

  // Conecta ou reconecta um número. Se o WhatsApp pedir, os QR Codes chegam pelo tempo real (instance:qrcode).
  app.post('/instances/:id/connect', async (req) => {
    const user = requireUser(req);
    const instance = await manageableNumber(db, user, parseId((req.params as { id: string }).id));
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
    const user = requireUser(req);
    const instance = await manageableNumber(db, user, parseId((req.params as { id: string }).id));
    return importHistory(db, instance.name).catch((e) => evolutionFailure(e, 'Não foi possível importar'));
  });

  // ---------- chamar um lead pelo WhatsApp do sistema ----------

  const requireWhatsapp = () => {
    if (!app.config.EVOLUTION_URL) throw conflict('O WhatsApp não está configurado neste servidor.');
  };

  // Abre a conversa com o lead pelo número escolhido (confere antes se o lead tem WhatsApp).
  app.post('/leads/:id/conversation', async (req) => {
    const user = requireUser(req);
    requireWhatsapp();
    const leadId = parseLeadId((req.params as { id: string }).id);
    const { instanceId } = parse(z.object({ instanceId: idSchema }), req.body ?? {});
    return startLeadChat(db, user, leadId, instanceId);
  });

  // Conversas já abertas com o lead (a janela de escolha do número mostra por qual número já se falou).
  app.get('/leads/:id/conversations', async (req) => {
    const user = requireUser(req);
    const lead = await leadForChat(db, user, parseLeadId((req.params as { id: string }).id));
    const rows = await db
      .selectFrom('wa_conversations as c')
      .innerJoin('wa_instances as i', 'i.id', 'c.instance_id')
      .select(['c.id', 'c.instance_id'])
      .where('c.lead_id', '=', lead.id)
      .where(visibleNumbers(user))
      .orderBy('c.last_message_at', (ob) => ob.desc().nullsLast())
      .execute();
    return rows.map((r) => ({ id: r.id, instanceId: r.instance_id }));
  });

  // ---------- conversas ----------

  // Lista de conversas, da mais recente para a mais antiga.
  // ?tab=responderam|todas  ?instanceId=3  ?q=maria  ?cursor=<id da última conversa recebida>  ?limit=50
  app.get('/conversations', async (req) => {
    const user = requireUser(req);
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
    // Conversa aberta pelo "Chamar" e ainda sem mensagens não entra na lista (só abre pelo lead).
    let query = conversationsQuery(db).where(visibleNumbers(user)).where('c.last_message_at', 'is not', null);
    if (q.tab === 'responderam') query = query.where('c.lead_replied', '=', true);
    if (q.instanceId) query = query.where('c.instance_id', '=', q.instanceId);
    if (q.q) {
      const text = `%${likeEscape(q.q)}%`;
      const digits = q.q.replace(/\D/g, '');
      query = query.where((eb) =>
        eb.or([
          eb('ct.name', 'ilike', text),
          eb('l.company', 'ilike', text),
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
    const user = requireUser(req);
    const [unread, disconnected] = await Promise.all([
      db
        .selectFrom('wa_conversations as c')
        .innerJoin('wa_instances as i', 'i.id', 'c.instance_id')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('c.unread_count', '>', 0)
        .where(visibleNumbers(user))
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('wa_instances as i')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('i.status', '<>', 'open')
        .where(visibleNumbers(user))
        .executeTakeFirstOrThrow(),
    ]);
    return { unreadConversations: Number(unread.n), disconnectedInstances: Number(disconnected.n) };
  });

  app.get('/conversations/:id', async (req) => {
    const user = requireUser(req);
    const id = parseId((req.params as { id: string }).id);
    const row = await conversationsQuery(db)
      .where('c.id', '=', id)
      .where(visibleNumbers(user))
      .executeTakeFirst();
    if (!row) throw notFound('Conversa não encontrada.');
    return conversationDto(row);
  });

  // Mensagens de uma conversa, em ordem cronológica. ?before=<id da mensagem mais antiga já carregada>
  app.get('/conversations/:id/messages', async (req) => {
    const user = requireUser(req);
    const id = parseId((req.params as { id: string }).id);
    await assertConversationVisible(db, user, id);
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
    const user = requireUser(req);
    const id = parseId((req.params as { id: string }).id);
    await assertConversationVisible(db, user, id);
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
    await assertConversationVisible(db, user, id);
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
      await assertConversationVisible(db, user, id);
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
      await assertConversationVisible(db, user, id);
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
    const user = requireUser(req);
    const id = parseId((req.params as { id: string }).id);
    const found = await db
      .selectFrom('wa_messages as m')
      .innerJoin('wa_instances as i', 'i.id', 'm.instance_id')
      .selectAll('m')
      .select('i.owner_id')
      .where('m.id', '=', id)
      .executeTakeFirst();
    if (!found || !canSeeNumber(user, found)) throw notFound('Mídia não encontrada.');
    const { owner_id: _owner, ...message } = found;
    if (!isMediaMessage(message)) throw notFound('Mídia não encontrada.');
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
