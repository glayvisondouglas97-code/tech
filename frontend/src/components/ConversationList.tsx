import { Inbox, Search, SearchX, WifiOff, X } from 'lucide-react';
import { memo, useMemo, type CSSProperties, type UIEvent } from 'react';
import type { ConversationsState } from '../App.tsx';
import type { ConversationItem, InstanceInfo, Tab } from '../api.ts';
import { contactName, formatPhone, instanceColor, instanceLabel, listTime } from '../format.ts';
import { useOnline } from '../socket.ts';
import { Avatar, EmptyState, InstanceChip } from './ui.tsx';

type Props = {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  instances: InstanceInfo[];
  instanceId: number | null;
  onInstanceChange: (id: number | null) => void;
  search: string;
  onSearchChange: (value: string) => void;
  query: string;
  conversations: ConversationsState;
  selectedId: number | null;
  onSelect: (id: number) => void;
};

export function ConversationList(props: Props) {
  const { tab, onTabChange, instances, instanceId, onInstanceChange, search, onSearchChange, query } = props;
  const { conversations, selectedId, onSelect } = props;
  const online = useOnline();
  // Apelido do número vem da lista de números (atualizada em tempo real), não da conversa.
  const labels = useMemo(() => new Map(instances.map((i) => [i.id, instanceLabel(i)])), [instances]);

  const onScroll = (e: UIEvent<HTMLUListElement>) => {
    const el = e.currentTarget;
    if (conversations.hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < 400) conversations.loadMore();
  };

  return (
    <aside className="list-panel">
      <header className="list-header">
        <div className="list-title">
          <h1>Conversas</h1>
        </div>

        <div className="search" role="search">
          <Search aria-hidden />
          <input
            type="text"
            inputMode="search"
            enterKeyHint="search"
            value={search}
            maxLength={60}
            placeholder="Buscar por nome ou telefone"
            aria-label="Buscar conversa por nome ou telefone"
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onSearchChange('')}
          />
          {search && (
            <button type="button" className="icon-btn" onClick={() => onSearchChange('')} aria-label="Limpar busca">
              <X />
            </button>
          )}
        </div>

        <div className="segmented" role="tablist" aria-label="Quais conversas mostrar">
          <button role="tab" aria-selected={tab === 'responderam'} onClick={() => onTabChange('responderam')}>
            Responderam
          </button>
          <button role="tab" aria-selected={tab === 'todas'} onClick={() => onTabChange('todas')}>
            Todas
          </button>
        </div>

        {instances.length > 1 && (
          <div className="filter-chips" role="group" aria-label="Filtrar por número">
            <button className="filter-chip" aria-pressed={instanceId === null} onClick={() => onInstanceChange(null)}>
              Todos os números
            </button>
            {instances.map((i) => (
              <button
                key={i.id}
                className="filter-chip"
                aria-pressed={instanceId === i.id}
                onClick={() => onInstanceChange(instanceId === i.id ? null : i.id)}
              >
                <span className="chip-dot" style={{ '--instance-color': instanceColor(i.id) } as CSSProperties} aria-hidden />
                {instanceLabel(i)}
                {i.status !== 'open' && <WifiOff className="off" aria-label="desconectado" />}
              </button>
            ))}
          </div>
        )}
      </header>

      {!online && (
        <div className="offline" role="status">
          <WifiOff aria-hidden />
          Sem conexão com o servidor. Tentando reconectar…
        </div>
      )}

      <ul className="conversation-list" onScroll={onScroll} aria-busy={conversations.loading}>
        {conversations.items.map((c) => (
          <li key={c.id}>
            <ConversationRow
              conversation={c}
              label={labels.get(c.instance.id) ?? instanceLabel(c.instance)}
              selected={c.id === selectedId}
              onSelect={onSelect}
            />
          </li>
        ))}
        {conversations.loading && <SkeletonRows />}
        {!conversations.loading && conversations.items.length === 0 && (
          <li>
            {query ? (
              <EmptyState icon={SearchX} title={`Nada encontrado para “${query}”`}>
                {tab === 'responderam' ? 'Procure também na aba Todas.' : 'Confira o nome ou digite parte do telefone.'}
              </EmptyState>
            ) : tab === 'responderam' ? (
              <EmptyState icon={Inbox} title="Nenhum lead respondeu ainda">
                Quando alguém responder, a conversa aparece aqui. As demais ficam na aba Todas.
              </EmptyState>
            ) : (
              <EmptyState icon={Inbox} title="Nenhuma conversa ainda">
                As conversas dos números conectados aparecem aqui.
              </EmptyState>
            )}
          </li>
        )}
      </ul>
    </aside>
  );
}

type RowProps = { conversation: ConversationItem; label: string; selected: boolean; onSelect: (id: number) => void };

// Só redesenha a linha que mudou (importante com muitas conversas e mensagens chegando o tempo todo).
const ConversationRow = memo(function ConversationRow({ conversation: c, label, selected, onSelect }: RowProps) {
  const unread = c.unreadCount > 0;
  return (
    <button
      className={`conversation ${selected ? 'selected' : ''} ${unread ? 'unread' : ''}`}
      aria-current={selected || undefined}
      onClick={() => onSelect(c.id)}
    >
      <Avatar name={c.contact.name} seed={c.contact.phone ?? String(c.contact.id)} />
      <span className="conversation-main">
        <span className="conversation-top">
          <span className="conversation-name">{contactName(c.contact)}</span>
          <span className="conversation-time">{listTime(c.lastMessageAt)}</span>
        </span>
        <span className="conversation-bottom">
          <span className="conversation-preview">
            {c.lastMessageFromMe && <span className="preview-me">Você:</span>}
            <span>{c.lastMessagePreview || ' '}</span>
          </span>
          {unread && (
            <span className="unread-badge" aria-label={`${c.unreadCount} não lidas`}>
              {c.unreadCount > 99 ? '99+' : c.unreadCount}
            </span>
          )}
        </span>
        <span className="conversation-meta">
          <InstanceChip id={c.instance.id} label={label} />
          {c.contact.name && c.contact.phone && <span className="conversation-phone">{formatPhone(c.contact.phone)}</span>}
        </span>
      </span>
    </button>
  );
});

function SkeletonRows() {
  return Array.from({ length: 7 }, (_, i) => (
    <li key={`s${i}`} className="skeleton-row" aria-hidden>
      <span className="avatar" />
      <span className="skeleton-lines">
        <span className="skeleton-line" style={{ width: `${45 + ((i * 17) % 35)}%` }} />
        <span className="skeleton-line" style={{ width: `${65 + ((i * 11) % 30)}%` }} />
      </span>
    </li>
  ));
}
