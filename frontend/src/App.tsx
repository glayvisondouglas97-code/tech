import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  compareConversations,
  PAGE_SIZE,
  type ConversationItem,
  type ConversationRemovedEvent,
  type InstanceInfo,
  type Tab,
} from './api.ts';
import { ChatPanel } from './components/ChatPanel.tsx';
import { ConversationList } from './components/ConversationList.tsx';
import { NumbersPage } from './components/NumbersPage.tsx';
import { useReconnect, useSocketEvent } from './socket.ts';

// O endereço guarda a tela: #numeros para a tela de números, #12 para a conversa 12 aberta (o F5 mantém).
const pageFromHash = () => (window.location.hash === '#numeros' ? 'numeros' : 'conversas');
const idFromHash = () => Number(window.location.hash.slice(1)) || null;

export function App() {
  const [page, setPage] = useState<'conversas' | 'numeros'>(pageFromHash);
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [tab, setTab] = useState<Tab>('responderam');
  const [instanceId, setInstanceId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(idFromHash);
  const conversations = useConversations(tab, instanceId);

  const loadInstances = useCallback(() => api.instances().then(setInstances), []);
  useEffect(() => {
    void loadInstances();
  }, [loadInstances]);
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
  useSocketEvent<ConversationRemovedEvent>('conversation:removed', ({ id, mergedInto }) =>
    setSelectedId((current) => (current === id ? mergedInto : current)),
  );

  useEffect(() => {
    const hash = page === 'numeros' ? '#numeros' : selectedId ? `#${selectedId}` : '';
    window.history.replaceState(null, '', hash || window.location.pathname);
  }, [page, selectedId]);

  if (page === 'numeros') {
    return <NumbersPage instances={instances} onInstanceSaved={saveInstance} onBack={() => setPage('conversas')} />;
  }

  return (
    <div className={`app ${selectedId ? 'chat-open' : ''}`}>
      <ConversationList
        onOpenNumbers={() => setPage('numeros')}
        tab={tab}
        onTabChange={setTab}
        instances={instances}
        instanceId={instanceId}
        onInstanceChange={setInstanceId}
        conversations={conversations}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      {selectedId ? (
        <ChatPanel key={selectedId} conversationId={selectedId} instances={instances} onBack={() => setSelectedId(null)} />
      ) : (
        <main className="chat chat-empty">
          <p>Selecione uma conversa</p>
        </main>
      )}
    </div>
  );
}

export type ConversationsState = {
  items: ConversationItem[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
};

// Lista de conversas da aba/filtro atual. Carrega sob demanda e é atualizada pelos eventos de tempo real.
function useConversations(tab: Tab, instanceId: number | null): ConversationsState {
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  // Cada troca de aba/filtro gera uma nova "versão"; respostas de versões antigas são descartadas.
  const version = useRef(0);
  const loadingMore = useRef(false);

  useEffect(() => {
    const current = ++version.current;
    setItems([]);
    setLoading(true);
    api
      .conversations({ tab, instanceId: instanceId ?? undefined, limit: PAGE_SIZE })
      .then((list) => {
        if (current !== version.current) return;
        setItems(list);
        setHasMore(list.length === PAGE_SIZE);
      })
      .finally(() => current === version.current && setLoading(false));
  }, [tab, instanceId]);

  // Recarrega o que já está na tela (usado ao reconectar e após importar histórico).
  const reload = async () => {
    const current = version.current;
    const limit = Math.min(Math.max(itemsRef.current.length, PAGE_SIZE), 200);
    const list = await api.conversations({ tab, instanceId: instanceId ?? undefined, limit });
    if (current === version.current) setItems(list);
  };
  useReconnect(reload);
  useSocketEvent('conversations:reload', reload);

  useSocketEvent<ConversationItem>('conversation:updated', (updated) => {
    const matchesFilter = (tab === 'todas' || updated.leadReplied) && (instanceId === null || updated.instance.id === instanceId);
    setItems((prev) => {
      const others = prev.filter((c) => c.id !== updated.id);
      if (!matchesFilter) return others.length === prev.length ? prev : others;
      // Conversa antiga que ainda não foi carregada na lista: aparece quando a pessoa rolar até ela.
      const last = prev.at(-1);
      const alreadyListed = others.length !== prev.length;
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
      const more = await api.conversations({ tab, instanceId: instanceId ?? undefined, cursor: last.id, limit: PAGE_SIZE });
      if (current !== version.current) return;
      setItems((prev) => [...prev, ...more.filter((m) => !prev.some((p) => p.id === m.id))]);
      setHasMore(more.length === PAGE_SIZE);
    } finally {
      loadingMore.current = false;
    }
  }, [tab, instanceId]);

  return { items, loading, hasMore, loadMore };
}
