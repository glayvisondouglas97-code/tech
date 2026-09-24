// Telas guardadas no endereço (#numeros, #usuarios, #conta ou #12 para a conversa 12): o F5 mantém a tela
// e o botão "voltar" do celular fecha a conversa em vez de sair do sistema.
import { useMemo, useSyncExternalStore } from 'react';

export type Page = 'conversas' | 'numeros' | 'usuarios' | 'conta';
export type Route = { page: Page; conversationId: number | null };

const OTHER_PAGES: Page[] = ['numeros', 'usuarios', 'conta'];

export function parseRoute(hash: string): Route {
  const key = hash.replace(/^#/, '');
  if ((OTHER_PAGES as string[]).includes(key)) return { page: key as Page, conversationId: null };
  const id = Number(key);
  return { page: 'conversas', conversationId: Number.isInteger(id) && id > 0 ? id : null };
}

const hashOf = (route: Route) =>
  route.page !== 'conversas' ? route.page : route.conversationId ? String(route.conversationId) : '';
const isHome = (route: Route) => route.page === 'conversas' && !route.conversationId;

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
window.addEventListener('popstate', notify);

function write(route: Route, mode: 'push' | 'replace') {
  const hash = hashOf(route);
  const url = hash ? `#${hash}` : window.location.pathname + window.location.search;
  if (mode === 'push') window.history.pushState({ central: true }, '', url);
  else window.history.replaceState(window.history.state, '', url);
  notify();
}

// A lista de conversas é a tela inicial. Sair dela cria um passo no histórico; trocar entre as outras telas
// substitui esse passo; voltar para a lista desfaz o passo. Assim o "voltar" sempre leva para a lista.
export function navigate(to: Route): void {
  const from = parseRoute(window.location.hash);
  if (hashOf(from) === hashOf(to)) return;
  if (!isHome(to)) write(to, isHome(from) ? 'push' : 'replace');
  else if (window.history.state?.central) window.history.back();
  else write(to, 'replace');
}

export function replaceRoute(to: Route): void {
  write(to, 'replace');
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return useMemo(() => parseRoute(hash), [hash]);
}
