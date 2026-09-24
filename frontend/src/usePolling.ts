import { useEffect, useLayoutEffect, useRef } from 'react';

// Executa fn a cada "ms" milissegundos. Provisório: na Fase 4 as atualizações chegam na hora via WebSocket.
export function usePolling(fn: () => Promise<unknown> | unknown, ms: number): void {
  const fnRef = useRef(fn);
  useLayoutEffect(() => {
    fnRef.current = fn;
  });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        await fnRef.current();
      } catch {
        // falha momentânea de rede: tenta de novo no próximo ciclo
      }
      if (!stopped) timer = setTimeout(tick, ms);
    };
    timer = setTimeout(tick, ms);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [ms]);
}
