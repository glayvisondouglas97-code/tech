/**
 * Tempo real: avisa os navegadores abertos (Socket.io) sempre que algo muda no WhatsApp.
 * Cada aviso vai só para quem pode ver aquele número (salas do Socket.io):
 * - "numeros:todos": dono, administrador e supervisor (veem todas as conversas);
 * - "numeros:gestao": dono e administrador (recebem o QR Code de qualquer número);
 * - "usuario:<id>": cada pessoa, que recebe os avisos dos números de que é responsável.
 */
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { can, type Role } from '../../../shared/roles';
import { loadSession, onSessionsDestroyed } from '../../auth/sessions';
import type { Db } from '../../db';
import type { WaMessage } from '../../db/schema';
import { conversationDto, conversationsQuery, instanceDto, instancesQuery, messageDto } from './dto';

let io: Server | undefined;
let database: Db | undefined;

const VIEWERS = 'numeros:todos';
const MANAGERS = 'numeros:gestao';
const userRoom = (id: string) => `usuario:${id}`;

function roleRooms(role: Role): string[] {
  return [...(can.seeAllNumbers(role) ? [VIEWERS] : []), ...(can.manageNumbers(role) ? [MANAGERS] : [])];
}

/** Responsável de cada número (cache: muda só quando alguém troca o responsável). */
const owners = new Map<number, string | null>();

async function ownerOf(instanceId: number): Promise<string | null> {
  if (!owners.has(instanceId) && database) {
    const row = await database
      .selectFrom('wa_instances')
      .select('owner_id')
      .where('id', '=', instanceId)
      .executeTakeFirst();
    owners.set(instanceId, row?.owner_id ?? null);
  }
  return owners.get(instanceId) ?? null;
}

/** Quem recebe os avisos de um número: quem vê todos (ou gerencia todos) e o responsável. */
function audience(owner: string | null, base = VIEWERS): string[] {
  return owner ? [base, userRoom(owner)] : [base];
}

/** Aviso não pode derrubar quem chamou (webhook, envio): em caso de erro, só registra. */
async function safely(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`[tempo real] falha ao avisar ${what}:`, (error as Error).message);
  }
}

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
    socket.data.role = session.user.role;
    next();
  });
  io.on('connection', (socket) => {
    void socket.join([userRoom(socket.data.userId), ...roleRooms(socket.data.role)]);
  });
  return io;
}

export function stopRealtime(): void {
  io?.close();
  io = undefined;
  owners.clear();
}

/** O papel da pessoa mudou: as telas abertas passam a receber os avisos do papel novo e recarregam. */
export function refreshUserAccess(userId: string, role: Role): void {
  if (!io) return;
  io.in(userRoom(userId)).socketsLeave([VIEWERS, MANAGERS]);
  const rooms = roleRooms(role);
  if (rooms.length) io.in(userRoom(userId)).socketsJoin(rooms);
  io.to(userRoom(userId)).emit('conversations:reload');
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
  await safely(`a conversa ${id}`, async () => {
    if (!io || !database) return;
    const row = await conversationsQuery(database).where('c.id', '=', id).executeTakeFirst();
    if (!row) return;
    owners.set(row.instance_id, row.instance_owner_id);
    io.to(audience(row.instance_owner_id)).emit('conversation:updated', conversationDto(row));
  });
}

export async function publishConversationRemoved(id: number, mergedInto: number, instanceId: number) {
  await safely(`a junção da conversa ${id}`, async () => {
    if (!io) return;
    io.to(audience(await ownerOf(instanceId))).emit('conversation:removed', { id, mergedInto });
  });
}

export async function publishMessage(event: 'message:new' | 'message:updated', message: WaMessage) {
  await safely(`a mensagem ${message.id}`, async () => {
    if (!io) return;
    io.to(audience(await ownerOf(message.instance_id))).emit(event, {
      conversationId: message.conversation_id,
      message: messageDto(message),
    });
  });
}

/** Número conectou, caiu, mudou de apelido ou de responsável. */
export async function publishInstance(instanceId: number): Promise<void> {
  await safely(`o número ${instanceId}`, async () => {
    if (!io || !database) return;
    const row = await instancesQuery(database).where('i.id', '=', instanceId).executeTakeFirst();
    if (!row) return;
    owners.set(row.id, row.owner_id);
    io.to(audience(row.owner_id)).emit('instance:updated', instanceDto(row));
  });
}

/**
 * O responsável de um número mudou: o novo passa a ver as conversas; o antigo (se não vê todos os
 * números) deixa de ver. As telas dos dois recarregam.
 */
export async function publishOwnerChange(
  instanceId: number,
  previousOwner: string | null,
  newOwner: string | null,
): Promise<void> {
  owners.delete(instanceId);
  await publishInstance(instanceId);
  if (!io) return;
  if (previousOwner && previousOwner !== newOwner) {
    io.to(userRoom(previousOwner)).except(VIEWERS).emit('instance:removed', { id: instanceId });
    io.to(userRoom(previousOwner)).emit('conversations:reload');
  }
  if (newOwner) io.to(userRoom(newOwner)).emit('conversations:reload');
}

/**
 * Muitas mudanças de uma vez: a tela recarrega a lista de conversas. Com o número, avisa só quem vê
 * aquele número (importação de histórico); sem ele, todos (LGPD).
 */
export async function publishReload(instanceId?: number): Promise<void> {
  await safely('a recarga das conversas', async () => {
    if (!io) return;
    if (instanceId === undefined) io.emit('conversations:reload');
    else io.to(audience(await ownerOf(instanceId))).emit('conversations:reload');
  });
}

/**
 * Novo QR Code de um número (ou null quando o QR expirou e é preciso pedir outro). Vai só para o
 * responsável e para quem gerencia todos os números: com o QR Code, qualquer um conectaria o número.
 */
export async function publishQrCode(instanceId: number, qrcode: string | null): Promise<void> {
  await safely(`o QR Code do número ${instanceId}`, async () => {
    if (!io) return;
    io.to(audience(await ownerOf(instanceId), MANAGERS)).emit('instance:qrcode', { instanceId, qrcode });
  });
}

/** Mensagens apagadas: a conversa aberta tira as mensagens da tela. */
export async function publishMessagesDeleted(
  instanceId: number,
  ownerId: string | null,
  conversationId: number,
  ids: number[],
): Promise<void> {
  owners.set(instanceId, ownerId);
  io?.to(audience(ownerId)).emit('message:deleted', { conversationId, ids });
}

/** Conversa excluída: sai da lista e, se estiver aberta, fecha. */
export async function publishConversationDeleted(
  conversationId: number,
  instanceId: number,
  ownerId: string | null,
): Promise<void> {
  owners.set(instanceId, ownerId);
  io?.to(audience(ownerId)).emit('conversation:deleted', { id: conversationId });
}

/** Número excluído: some da tela de números e as conversas dele saem da lista. */
export async function publishInstanceDeleted(instanceId: number, ownerId: string | null): Promise<void> {
  owners.delete(instanceId);
  const rooms = audience(ownerId);
  io?.to(rooms).emit('instance:removed', { id: instanceId });
  io?.to(rooms).emit('conversations:reload');
}
