import { KeyRound, LogOut, MessageCircle, MessagesSquare, Smartphone, UserRound, Users, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  compareConversations,
  PAGE_SIZE,
  type ConversationItem,
  type ConversationRemovedEvent,
  type CurrentUser,
  type InstanceInfo,
  type Stats,
  type Tab,
} from './api.ts';
import { AccountPage } from './components/AccountPage.tsx';
import { ChatPanel } from './components/ChatPanel.tsx';
import { ConversationList } from './components/ConversationList.tsx';
import { LoginPage } from './components/LoginPage.tsx';
import { NumbersPage } from './components/NumbersPage.tsx';
import { PasswordModal } from './components/PasswordModal.tsx';
import { UsersPage } from './components/UsersPage.tsx';
import { Avatar, EmptyState, Menu, Toaster } from './components/ui.tsx';
import { navigate, replaceRoute, useRoute, type Page } from './router.ts';
import { socket, useReconnect, useSocketEvent } from './socket.ts';

// Primeiro confere o login. Sem login, só a tela de entrada; com login, o sistema e o tempo real.
export function App() {
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined); // undefined = conferindo

  useEffect(() => {
    api.me().then(setUser, () => setUser(null));
    const onExpired = () => setUser(null);
    window.addEventListener('auth-expired', onExpired);
    return () => window.removeEventListener('auth-expired', onExpired);
  }, []);

  useEffect(() => {
    if (user) socket.connect();
    else socket.disconnect();
  }, [user]);

  if (user === undefined) {
    return (
      <main className="splash">
        <img src="/logo.svg" alt="Carregando" width={56} height={56} />
      </main>
    );
  }
  if (!user) return <LoginPage onLogin={setUser} />;
  return (
    <Workspace
      user={user}
      onLogout={() => {
        void api.logout().finally(() => setUser(null));
      }}
    />
  );
}

type NavItem = { page: Page; label: string; icon: LucideIcon; badge?: number; alert?: boolean };

function NavBadge({ item }: { item: NavItem }) {
  if (!item.badge) return null;
  return <span className={`nav-badge ${item.alert ? 'alert' : ''}`}>{item.badge > 99 ? '99+' : item.badge}</span>;
}

function Workspace({ user, onLogout }: { user: CurrentUser; onLogout: () => void }) {
  const route = useRoute();
  const page: Page = route.page === 'usuarios' && !user.isAdmin ? 'conversas' : route.page;
  const selectedId = page === 'conversas' ? route.conversationId : null;
  const [changingPassword, setChangingPassword] = useState(false);
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [tab, setTab] = useState<Tab>('responderam');
  const [instanceId, setInstanceId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), 300);
  const conversations = useConversations(tab, instanceId, query);
  const stats = useStats();

  const [instancesLoaded, setInstancesLoaded] = useState(false);
  const loadInstances = useCallback(
    () =>
      void api.instances().then((list) => {
        setInstances(list);
        setInstancesLoaded(true);
      }, () => {}),
    [],
  );
  useEffect(loadInstances, [loadInstances]);
  useReconnect(loadInstances);
  const saveInstance = useCallback(
    (updated: InstanceInfo) =>
      setInstances((prev) =>
        prev.some((i) => i.id === updated.id)
          ? prev.map((i) => (i.id === updated.id ? updated : i))
          : [...prev, updated].sort((a, b) => a.name.localeCompare(b.name)),
      ),
    [],
  );
  useSocketEvent<InstanceInfo>('instance:updated', saveInstance);

  // Se a conversa aberta foi juntada a outra (mesmo lead por telefone e @lid), abre a que ficou.
  useSocketEvent<ConversationRemovedEvent>('conversation:removed', ({ id, mergedInto }) => {
    if (selectedId === id) replaceRoute({ page: 'conversas', conversationId: mergedInto });
  });

  // Não lidas no título da aba do navegador: "(3) Central WhatsApp".
  useEffect(() => {
    document.title = stats.unreadConversations ? `(${stats.unreadConversations}) Central WhatsApp` : 'Central WhatsApp';
  }, [stats.unreadConversations]);

  const openConversation = useCallback((id: number) => navigate({ page: 'conversas', conversationId: id }), []);
  const closeConversation = useCallback(() => navigate({ page: 'conversas', conversationId: null }), []);
  const goTo = (target: Page) => target !== page && navigate({ page: target, conversationId: null });

  const nav: NavItem[] = [
    { page: 'conversas', label: 'Conversas', icon: MessageCircle, badge: stats.unreadConversations },
    { page: 'numeros', label: 'Números', icon: Smartphone, badge: stats.disconnectedInstances, alert: true },
    ...(user.isAdmin ? [{ page: 'usuarios' as const, label: 'Usuários', icon: Users }] : []),
  ];

  let content;
  if (page === 'numeros') content = <NumbersPage instances={instances} loaded={instancesLoaded} onInstanceSaved={saveInstance} />;
  else if (page === 'usuarios') content = <UsersPage me={user} />;
  else if (page === 'conta')
    content = <AccountPage user={user} onChangePassword={() => setChangingPassword(true)} onLogout={onLogout} />;
  else {
    content = (
      <div className={`inbox ${selectedId ? 'chat-open' : ''}`}>
        <ConversationList
          tab={tab}
          onTabChange={setTab}
          instances={instances}
          instanceId={instanceId}
          onInstanceChange={setInstanceId}
          search={search}
          onSearchChange={setSearch}
          query={query}
          conversations={conversations}
          selectedId={selectedId}
          onSelect={openConversation}
        />
        {selectedId ? (
          <ChatPanel
            key={selectedId}
            conversationId={selectedId}
            preview={conversations.items.find((c) => c.id === selectedId)}
            instances={instances}
            onBack={closeConversation}
          />
        ) : (
          <section className="chat">
            <div className="chat-placeholder">
              <EmptyState icon={MessagesSquare} title="Selecione uma conversa">
                A resposta sai sempre pelo mesmo número que recebeu a mensagem.
              </EmptyState>
            </div>
          </section>
        )}
      </div>
    );
  }

  return (
    <div className={`shell ${selectedId ? 'chat-open' : ''}`}>
      <nav className="rail" aria-label="Menu principal">
        <img className="rail-logo" src="/logo.svg" alt="Central WhatsApp" width={40} height={40} />
        {nav.map((item) => (
          <button
            key={item.page}
            className="rail-item"
            aria-current={page === item.page ? 'page' : undefined}
            onClick={() => goTo(item.page)}
          >
            <item.icon aria-hidden />
            {item.label}
            <NavBadge item={item} />
          </button>
        ))}
        <div className="rail-spacer" />
        <Menu
          label="Minha conta"
          buttonClassName="rail-avatar"
          button={<Avatar name={user.name} seed={user.email} size="sm" />}
          placement="up-right"
          header={
            <>
              <strong>{user.name}</strong>
              <span>{user.email}</span>
            </>
          }
          items={[
            { label: 'Minha senha', icon: KeyRound, onSelect: () => setChangingPassword(true) },
            { label: 'Sair', icon: LogOut, onSelect: onLogout, danger: true },
          ]}
        />
      </nav>

      <div className="content">{content}</div>

      <nav className="bottom-nav" aria-label="Menu principal">
        {[...nav, { page: 'conta' as const, label: 'Conta', icon: UserRound }].map((item) => (
          <button key={item.page} aria-current={page === item.page ? 'page' : undefined} onClick={() => goTo(item.page)}>
            <item.icon aria-hidden />
            {item.label}
            <NavBadge item={item} />
          </button>
        ))}
      </nav>

      {changingPassword && <PasswordModal onClose={() => setChangingPassword(false)} />}
      <Toaster />
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), value ? ms : 0); // apagar a busca vale na hora
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

// Selos do menu (não lidas e números desconectados). Recalcula logo depois das mudanças em tempo real.
function useStats(): Stats {
  const [stats, setStats] = useState<Stats>({ unreadConversations: 0, disconnectedInstances: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(() => void api.stats().then(setStats, () => {}), []);
  const schedule = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 500);
  };
  useEffect(() => {
    load();
    return () => clearTimeout(timer.current);
  }, [load]);
  useReconnect(load);
  useSocketEvent('conversation:updated', schedule);
  useSocketEvent('conversation:removed', schedule);
  useSocketEvent('conversations:reload', schedule);
  useSocketEvent('instance:updated', schedule);
  return stats;
}

export type ConversationsState = {
  items: ConversationItem[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
};

// Lista de conversas da aba/filtro/busca atual. Carrega sob demanda e é atualizada pelos eventos de tempo real.
function useConversations(tab: Tab, instanceId: number | null, q: string): ConversationsState {
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  // Cada troca de aba/filtro/busca gera uma nova "versão"; respostas de versões antigas são descartadas.
  const version = useRef(0);
  const loadingMore = useRef(false);
  const params = useMemo(() => ({ tab, instanceId: instanceId ?? undefined, q: q || undefined }), [tab, instanceId, q]);

  useEffect(() => {
    const current = ++version.current;
    setItems([]);
    setHasMore(false);
    setLoading(true);
    api
      .conversations({ ...params, limit: PAGE_SIZE })
      .then((list) => {
        if (current !== version.current) return;
        setItems(list);
        setHasMore(list.length === PAGE_SIZE);
      })
      .catch(() => {})
      .finally(() => current === version.current && setLoading(false));
  }, [params]);

  // Recarrega o que já está na tela (usado ao reconectar e após importar histórico).
  const reload = async () => {
    const current = version.current;
    const limit = Math.min(Math.max(itemsRef.current.length, PAGE_SIZE), 200);
    const list = await api.conversations({ ...params, limit });
    if (current === version.current) setItems(list);
  };
  useReconnect(() => void reload().catch(() => {}));
  useSocketEvent('conversations:reload', () => void reload().catch(() => {}));

  useSocketEvent<ConversationItem>('conversation:updated', (updated) => {
    const matchesFilter = (tab === 'todas' || updated.leadReplied) && (instanceId === null || updated.instance.id === instanceId);
    setItems((prev) => {
      const others = prev.filter((c) => c.id !== updated.id);
      const alreadyListed = others.length !== prev.length;
      if (!matchesFilter) return alreadyListed ? others : prev;
      // Com busca ativa, só atualiza as conversas que já estão no resultado.
      if (q && !alreadyListed) return prev;
      // Conversa antiga que ainda não foi carregada na lista: aparece quando a pessoa rolar até ela.
      const last = prev.at(-1);
      if (!alreadyListed && hasMoreRef.current && last && compareConversations(updated, last) > 0) return prev;
      return [...others, updated].sort(compareConversations);
    });
  });

  useSocketEvent<ConversationRemovedEvent>('conversation:removed', ({ id }) =>
    setItems((prev) => prev.filter((c) => c.id !== id)),
  );

  const loadMore = useCallback(async () => {
    const last = itemsRef.current.at(-1);
    if (!last || loadingMore.current) return;
    loadingMore.current = true;
    const current = version.current;
    try {
      const more = await api.conversations({ ...params, cursor: last.id, limit: PAGE_SIZE });
      if (current !== version.current) return;
      setItems((prev) => [...prev, ...more.filter((m) => !prev.some((p) => p.id === m.id))]);
      setHasMore(more.length === PAGE_SIZE);
    } catch {
      // tenta de novo na próxima rolagem
    } finally {
      loadingMore.current = false;
    }
  }, [params]);

  return { items, loading, hasMore, loadMore };
}
