import type { ConversationsState } from '../App.tsx';
import type { InstanceInfo, Tab } from '../api.ts';
import { contactName, formatPhone, instanceColor, instanceLabel, listTime } from '../format.ts';
import { useOnline } from '../socket.ts';

type Props = {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  instances: InstanceInfo[];
  instanceId: number | null;
  onInstanceChange: (id: number | null) => void;
  conversations: ConversationsState;
  selectedId: number | null;
  onSelect: (id: number) => void;
};

export function ConversationList(props: Props) {
  const { tab, onTabChange, instances, instanceId, onInstanceChange, conversations, selectedId, onSelect } = props;
  const online = useOnline();

  const onScroll = (e: React.UIEvent<HTMLUListElement>) => {
    const el = e.currentTarget;
    if (conversations.hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < 200) conversations.loadMore();
  };

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h1>Conversas</h1>
      </header>

      {!online && (
        <div className="offline-banner" role="status">
          Sem conexão com o servidor. Tentando reconectar… As mensagens novas aparecem assim que voltar.
        </div>
      )}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'responderam'} onClick={() => onTabChange('responderam')}>
          Responderam
        </button>
        <button role="tab" aria-selected={tab === 'todas'} onClick={() => onTabChange('todas')}>
          Todas
        </button>
      </div>

      <label className="filter">
        <span>Número</span>
        <select value={instanceId ?? ''} onChange={(e) => onInstanceChange(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Todos os números</option>
          {instances.map((i) => (
            <option key={i.id} value={i.id}>
              {instanceLabel(i)}
              {i.status !== 'open' ? ' (desconectado)' : ''}
            </option>
          ))}
        </select>
      </label>

      <ul className="conversation-list" onScroll={onScroll}>
        {conversations.items.map((c) => {
          const name = contactName(c.contact);
          return (
            <li key={c.id}>
              <button className={`conversation ${c.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(c.id)}>
                <span className="avatar" aria-hidden>
                  {c.contact.name?.replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase() || '#'}
                </span>
                <span className="conversation-main">
                  <span className="conversation-top">
                    <span className="conversation-name">{name}</span>
                    <span className={`conversation-time ${c.unreadCount ? 'unread' : ''}`}>{listTime(c.lastMessageAt)}</span>
                  </span>
                  {c.contact.name && c.contact.phone && <span className="conversation-phone">{formatPhone(c.contact.phone)}</span>}
                  <span className="conversation-bottom">
                    <span className="conversation-preview">
                      {c.lastMessageFromMe && <span className="preview-me">Você: </span>}
                      {c.lastMessagePreview}
                    </span>
                    {c.unreadCount > 0 && <span className="unread-badge">{c.unreadCount}</span>}
                  </span>
                  <span className="instance-badge" style={{ '--instance-color': instanceColor(c.instance.id) } as React.CSSProperties}>
                    {instanceLabel(c.instance)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {conversations.loading && <li className="list-info">Carregando…</li>}
        {!conversations.loading && conversations.items.length === 0 && (
          <li className="list-info">{tab === 'responderam' ? 'Nenhum lead respondeu ainda.' : 'Nenhuma conversa.'}</li>
        )}
      </ul>
    </aside>
  );
}
