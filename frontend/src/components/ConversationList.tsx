import type { ConversationsState } from '../App.tsx';
import type { CurrentUser, InstanceInfo, Tab } from '../api.ts';
import { contactName, formatPhone, instanceColor, instanceLabel, listTime } from '../format.ts';
import { useOnline } from '../socket.ts';

type Props = {
  user: CurrentUser;
  onOpenNumbers: () => void;
  onOpenUsers: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
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
  const { user, onOpenNumbers, onOpenUsers, onChangePassword, onLogout } = props;
  const { tab, onTabChange, instances, instanceId, onInstanceChange, conversations, selectedId, onSelect } = props;
  const online = useOnline();
  const disconnected = instances.filter((i) => i.status !== 'open').length;
  // Apelido e cor vêm da lista de números (atualizada em tempo real), não da conversa.
  const liveInstance = (i: { id: number; name: string; nickname: string | null }) => instances.find((x) => x.id === i.id) ?? i;

  const onScroll = (e: React.UIEvent<HTMLUListElement>) => {
    const el = e.currentTarget;
    if (conversations.hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < 200) conversations.loadMore();
  };

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h1>Conversas</h1>
        <button className={`numbers-button ${disconnected ? 'warn' : ''}`} onClick={onOpenNumbers}>
          Números{disconnected > 0 && ` · ${disconnected} desconectado${disconnected > 1 ? 's' : ''}`}
        </button>
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
                    {instanceLabel(liveInstance(c.instance))}
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

      <footer className="sidebar-footer">
        <span className="sidebar-user" title={user.email}>
          👤 {user.name}
        </span>
        <button className="link-button" onClick={onChangePassword}>
          Minha senha
        </button>
        {user.isAdmin && (
          <button className="link-button" onClick={onOpenUsers}>
            Usuários
          </button>
        )}
        <button className="link-button" onClick={onLogout}>
          Sair
        </button>
      </footer>
    </aside>
  );
}
