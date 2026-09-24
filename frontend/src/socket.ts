// Conexão em tempo real com o backend (Socket.io). Reconecta sozinha se cair.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

export const socket = io();

// Mantém sempre a versão mais recente da função, sem precisar reinscrever o evento.
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

// Quando a conexão volta depois de cair, o que aconteceu no meio tempo precisa ser buscado de novo.
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

export function useOnline(): boolean {
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
