/** Tempo real do WhatsApp (Socket.io): mensagens, conversas e números chegam sem recarregar a tela. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

// Só conecta com alguém logado (ver Shell).
export const socket = io({ autoConnect: false });

let onAuthProblem: (() => void) | null = null;

/** O Shell avisa a sessão quando o servidor recusa ou derruba o tempo real (login vencido ou encerrado). */
export function setRealtimeAuthHandler(fn: (() => void) | null) {
  onAuthProblem = fn;
}

socket.on('connect_error', (error) => {
  if (error.message === 'unauthorized') onAuthProblem?.();
});
socket.on('disconnect', (reason) => {
  // O servidor só derruba a conexão de quem saiu, teve a senha redefinida ou foi desativado.
  if (reason === 'io server disconnect') onAuthProblem?.();
});

/** Mantém sempre a versão mais recente da função, sem precisar reinscrever o evento. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

export function useSocketEvent<T>(event: string, handler: (payload: T) => void): void {
  const latest = useLatest(handler);
  useEffect(() => {
    const listener = (payload: T) => latest.current(payload);
    socket.on(event, listener);
    return () => {
      socket.off(event, listener);
    };
  }, [event, latest]);
}

/** Quando a conexão volta depois de cair, o que aconteceu no meio tempo precisa ser buscado de novo. */
export function useReconnect(handler: () => void): void {
  const latest = useLatest(handler);
  useEffect(() => {
    const listener = () => latest.current();
    socket.io.on('reconnect', listener);
    return () => {
      socket.io.off('reconnect', listener);
    };
  }, [latest]);
}

/** Se o tempo real está conectado ao servidor. */
export function useRealtimeOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    socket.on('connect', up);
    socket.on('disconnect', down);
    socket.on('connect_error', down);
    return () => {
      socket.off('connect', up);
      socket.off('disconnect', down);
      socket.off('connect_error', down);
    };
  }, []);
  return online;
}
