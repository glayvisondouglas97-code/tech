import { useCallback, useEffect, useRef, useState } from 'react';
import { api, PAGE_SIZE, type ConversationItem, type InstanceInfo, type Tab } from './api.ts';
import { ChatPanel } from './components/ChatPanel.tsx';
import { ConversationList } from './components/ConversationList.tsx';
import { usePolling } from './usePolling.ts';

// A conversa aberta fica no endereço (#12), então um F5 mantém o chat aberto.
const idFromHash = () => Number(window.location.hash.slice(1)) || null;

export function App() {
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [tab, setTab] = useState<Tab>('responderam');
  const [instanceId, setInstanceId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(idFromHash);
  const conversations = useConversations(tab, instanceId);

  const loadInstances = useCallback(() => api.instances().then(setInstances), []);
  useEffect(() => {
    void loadInstances();
  }, [loadInstances]);
  usePolling(loadInstances, 15_000);

  useEffect(() => {
    window.history.replaceState(null, '', selectedId ? `#${selectedId}` : window.location.pathname);
  }, [selectedId]);

  return (
    <div className={`app ${selectedId ? 'chat-open' : ''}`}>
      <ConversationList
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
        <ChatPanel
          key={selectedId}
          conversationId={selectedId}
          onBack={() => setSelectedId(null)}
          onConversationChanged={conversations.refresh}
        />
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
  refresh: () => void;
};

// Lista de conversas da aba/filtro atual, com "carregar mais" e atualização periódica.
function useConversations(tab: Tab, instanceId: number | null): ConversationsState {
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
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

  const refresh = useCallback(async () => {
    const current = version.current;
    const limit = Math.min(Math.max(itemsRef.current.length, PAGE_SIZE), 200);
    const list = await api.conversations({ tab, instanceId: instanceId ?? undefined, limit });
    if (current === version.current) setItems(list);
  }, [tab, instanceId]);

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

  usePolling(refresh, 5_000);

  return { items, loading, hasMore, loadMore, refresh };
}
