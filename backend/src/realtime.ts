// Tempo real: avisa os navegadores abertos (Socket.io) sempre que algo muda.
// Hoje todos recebem tudo. Quando existirem permissões por número, basta enviar para "salas" por número aqui.
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { prisma } from './db.ts';
import { conversationDto, instanceDto, messageDto } from './dto.ts';
import type { Instance, Message } from './generated/prisma/client.ts';

let io: Server | undefined;

export function startRealtime(server: HttpServer): void {
  io = new Server(server, { serveClient: false });
}

export async function publishConversation(id: number): Promise<void> {
  if (!io) return;
  const conversation = await prisma.conversation.findUnique({ where: { id }, include: { contact: true, instance: true } });
  if (conversation) io.emit('conversation:updated', conversationDto(conversation));
}

export function publishConversationRemoved(id: number, mergedInto: number): void {
  io?.emit('conversation:removed', { id, mergedInto });
}

export function publishMessage(event: 'message:new' | 'message:updated', message: Message): void {
  io?.emit(event, { conversationId: message.conversationId, message: messageDto(message) });
}

export function publishInstance(instance: Instance): void {
  io?.emit('instance:updated', instanceDto(instance));
}

// Muitas mudanças de uma vez (importação de histórico): o navegador recarrega a lista.
export function publishReload(): void {
  io?.emit('conversations:reload');
}
