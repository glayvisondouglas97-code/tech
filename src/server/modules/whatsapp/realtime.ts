/**
 * Tempo real: avisa os navegadores abertos (Socket.io) sempre que algo muda no WhatsApp.
 * Hoje todos da equipe recebem tudo (todos veem todas as conversas). Para permissões por número no futuro,
 * basta enviar para "salas" por número aqui.
 */
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { loadSession, onSessionsDestroyed } from '../../auth/sessions';
import type { Db } from '../../db';
import type { WaInstance, WaMessage } from '../../db/schema';
import { conversationDto, conversationsQuery, instanceDto, messageDto } from './dto';

let io: Server | undefined;
let database: Db | undefined;

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function startRealtime(
  server: HttpServer,
  db: Db,
  opts: { cookieName: string; appOrigin: string },
): Server {
  database = db;
  io = new Server(server, {
    serveClient: false,
    // WebSocket não passa pelo CORS: confere a origem aqui (só o próprio sistema conecta).
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      const originHost = origin ? URL.parse(origin)?.host : null;
      callback(null, !origin || origin === opts.appOrigin || originHost === req.headers.host);
    },
  });
  // Só quem está logado recebe as atualizações.
  io.use(async (socket, next) => {
    const token = readCookie(socket.handshake.headers.cookie, opts.cookieName);
    const session = token ? await loadSession(db, token).catch(() => null) : null;
    if (!session) return next(new Error('unauthorized'));
    socket.data.userId = session.user.id;
    socket.data.sessionId = session.sessionId;
    next();
  });
  return io;
}

export function stopRealtime(): void {
  io?.close();
  io = undefined;
}

// Sessão encerrada (sair, senha redefinida, pessoa desativada): derruba o tempo real dela na hora.
onSessionsDestroyed(async ({ sessionId, userId, exceptSessionId }) => {
  if (!io) return;
  for (const socket of await io.fetchSockets()) {
    const matches =
      (sessionId && socket.data.sessionId === sessionId) ||
      (userId && socket.data.userId === userId && socket.data.sessionId !== exceptSessionId);
    if (matches) socket.disconnect(true);
  }
});

export async function publishConversation(id: number): Promise<void> {
  if (!io || !database) return;
  const row = await conversationsQuery(database).where('c.id', '=', id).executeTakeFirst();
  if (row) io.emit('conversation:updated', conversationDto(row));
}

export function publishConversationRemoved(id: number, mergedInto: number): void {
  io?.emit('conversation:removed', { id, mergedInto });
}

export function publishMessage(event: 'message:new' | 'message:updated', message: WaMessage): void {
  io?.emit(event, { conversationId: message.conversation_id, message: messageDto(message) });
}

export function publishInstance(instance: WaInstance): void {
  io?.emit('instance:updated', instanceDto(instance));
}

/** Muitas mudanças de uma vez (importação de histórico): o navegador recarrega a lista. */
export function publishReload(): void {
  io?.emit('conversations:reload');
}

/** Novo QR Code de um número (ou null quando o QR expirou e é preciso pedir outro). */
export function publishQrCode(instanceId: number, qrcode: string | null): void {
  io?.emit('instance:qrcode', { instanceId, qrcode });
}
