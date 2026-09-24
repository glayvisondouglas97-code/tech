import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import type { ConversationItem, ConversationRemovedEvent, ConversationTab } from '../../shared/conversations';
import { IconConversas } from '../components/Icons';
import { Empty } from '../components/ui';
import { ChatPanel } from '../components/wa/ChatPanel';
import { ConversationList, type ConversationsState } from '../components/wa/ConversationList';
import { useDebounced } from '../lib/hooks';
import { useReconnect, useSocketEvent } from '../lib/socket';
import { compareConversations, PAGE_SIZE, useWaInstances, wa } from '../lib/whatsapp';

/**
 * Conversas de todos os números: lista à esquerda e chat à direita (no celular, uma tela por vez).
 * O endereço guarda a conversa aberta (/conversas/12): o F5 mantém e o "voltar" do celular fecha o chat.
 */
export function ConversationsPage() {
  const params = useParams();
  const selectedId = Number(params.id) || null;
  const navigate = useNavigate();
  const location = useLocation();
  const navState = location.state as { fromList?: boolean; fromLead?: boolean } | null;
  // Vindo do "Chamar" de um lead, a conversa nova (sem resposta ainda) aparece na aba Todas.
  const [tab, setTab] = useState<ConversationTab>(() => (navState?.fromLead ? 'todas' : 'responderam'));
  const [instanceId, setInstanceId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim(), 300);
  const query = search.trim() ? debounced : ''; // apagar a busca vale na hora
  const conversations = useConversations(tab, instanceId, query);
  const instances = useWaInstances().data ?? [];

  // Abrir conversa: a partir da lista cria um passo no histórico (o "voltar" fecha o chat);
  // trocar de uma conversa para outra substitui o passo.
  const openConversation = useCallback(
    (id: number) => navigate(`/conversas/${id}`, { replace: !!selectedId, state: { fromList: true } }),
    [navigate, selectedId],
  );
  // Fechar volta para onde a pessoa estava: a lista de conversas ou, vindo do "Chamar", a fila de leads.
  const closeConversation = useCallback(() => {
    if (navState?.fromList || navState?.fromLead) navigate(-1);
    else navigate('/conversas', { replace: true });
  }, [navigate, navState]);

  // Se a conversa aberta foi juntada a outra (mesmo lead por telefone e @lid), abre a que ficou.
  useSocketEvent<ConversationRemovedEvent>('conversation:removed', ({ id, mergedInto }) => {
    if (selectedId === id) navigate(`/conversas/${mergedInto}`, { replace: true, state: location.state });
  });

  // No celular, o chat aberto ocupa a tela toda (sem a barra de cima e a de baixo).
  useEffect(() => {
    document.body.classList.toggle('wa-chat-open', !!selectedId);
    return () => document.body.classList.remove('wa-chat-open');
  }, [selectedId]);

  return (
    <div className={`wa-inbox${selectedId ? ' chat-open' : ''}`}>
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
        <section className="wa-chat wa-chat-empty">
          <div className="wa-chat-center">
            <Empty title="Selecione uma conversa" icon={<IconConversas />}>
              <p>A resposta sai sempre pelo mesmo número que recebeu a mensagem.</p>
            </Empty>
          </div>
        </section>
      )}
    </div>
  );
}

/** Lista de conversas da aba/filtro/busca atual. Carrega sob demanda e é atualizada pelo tempo real. */
function useConversations(tab: ConversationTab, instanceId: number | null, q: string): ConversationsState {
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
  const params = useMemo(
    () => ({ tab, instanceId: instanceId ?? undefined, q: q || undefined }),
    [tab, instanceId, q],
  );

  useEffect(() => {
    const current = ++version.current;
    setItems([]);
    setHasMore(false);
    setLoading(true);
    wa.conversations({ ...params, limit: PAGE_SIZE })
      .then((list) => {
        if (current !== version.current) return;
        setItems(list);
        setHasMore(list.length === PAGE_SIZE);
      })
      .catch(() => {})
      .finally(() => {
        if (current === version.current) setLoading(false);
      });
  }, [params]);

  // Recarrega o que já está na tela (usado ao reconectar e após importar histórico).
  const reload = async () => {
    const current = version.current;
    const limit = Math.min(Math.max(itemsRef.current.length, PAGE_SIZE), 200);
    const list = await wa.conversations({ ...params, limit });
    if (current === version.current) setItems(list);
  };
  useReconnect(() => void reload().catch(() => {}));
  useSocketEvent('conversations:reload', () => void reload().catch(() => {}));

  useSocketEvent<ConversationItem>('conversation:updated', (updated) => {
    if (!updated.lastMessageAt) return; // aberta pelo "Chamar" e ainda sem mensagens: fica fora da lista
    const matchesFilter =
      (tab === 'todas' || updated.leadReplied) && (instanceId === null || updated.instance.id === instanceId);
    setItems((prev) => {
      const others = prev.filter((c) => c.id !== updated.id);
      const alreadyListed = others.length !== prev.length;
      if (!matchesFilter) return alreadyListed ? others : prev;
      // Com busca ativa, só atualiza as conversas que já estão no resultado.
      if (q && !alreadyListed) return prev;
      // Conversa antiga que ainda não foi carregada na lista: aparece quando a pessoa rolar até ela.
      const last = prev.at(-1);
      if (!alreadyListed && hasMoreRef.current && last && compareConversations(updated, last) > 0)
        return prev;
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
      const more = await wa.conversations({ ...params, cursor: last.id, limit: PAGE_SIZE });
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
