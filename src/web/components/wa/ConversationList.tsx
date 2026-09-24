import { type CSSProperties, memo, type UIEvent, useMemo } from 'react';
import type { ConversationItem, ConversationTab, InstanceInfo } from '../../../shared/conversations';
import { plural } from '../../lib/format';
import { useRealtimeOnline } from '../../lib/socket';
import { useCanManageNumber } from '../../lib/wa-access';
import { conversationTitle, formatPhone, instanceColor, instanceLabel, listTime } from '../../lib/whatsapp';
import { IconCheck, IconChecks, IconConversas, IconSearch, IconTrash, IconWifiOff, IconX } from '../Icons';
import { Empty } from '../ui';
import { ContactAvatar } from './ContactAvatar';

export type ConversationsState = {
  items: ConversationItem[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  remove: (ids: number[]) => void;
};

/** Modo de seleção da lista (para excluir várias conversas de uma vez). */
export type ListSelection = {
  active: boolean;
  checked: Set<number>;
  onStart: () => void;
  onToggle: (id: number) => void;
  onSetAll: (ids: Set<number>) => void;
  onCancel: () => void;
  onDelete: () => void;
};

type Props = {
  tab: ConversationTab;
  onTabChange: (tab: ConversationTab) => void;
  instances: InstanceInfo[];
  instanceId: number | null;
  onInstanceChange: (id: number | null) => void;
  search: string;
  onSearchChange: (value: string) => void;
  query: string;
  conversations: ConversationsState;
  selectedId: number | null;
  onSelect: (id: number) => void;
  selection: ListSelection;
};

export function ConversationList(props: Props) {
  const { tab, onTabChange, instances, instanceId, onInstanceChange, search, onSearchChange, query } = props;
  const { conversations, selectedId, onSelect, selection } = props;
  const online = useRealtimeOnline();
  // Apelido do número vem da lista de números (atualizada em tempo real), não da conversa.
  const labels = useMemo(() => new Map(instances.map((i) => [i.id, instanceLabel(i)])), [instances]);
  // Só dá para marcar as conversas dos números que a pessoa cuida (responsável ou dono/administrador).
  const canManageNumber = useCanManageNumber();
  const manageable = useMemo(
    () => new Set(instances.filter((i) => canManageNumber(i)).map((i) => i.id)),
    [instances, canManageNumber],
  );
  const selectable = conversations.items.filter((c) => manageable.has(c.instance.id));
  const allChecked = selectable.length > 0 && selectable.every((c) => selection.checked.has(c.id));

  const onScroll = (e: UIEvent<HTMLUListElement>) => {
    const el = e.currentTarget;
    if (conversations.hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < 400)
      conversations.loadMore();
  };

  return (
    <aside className="wa-list">
      <header className="wa-list-head">
        <h1>Conversas</h1>
        <div className="wa-search-row">
          <div className="search">
            <IconSearch />
            <input
              className="input"
              type="text"
              inputMode="search"
              enterKeyHint="search"
              value={search}
              maxLength={60}
              placeholder="Buscar por nome ou telefone"
              aria-label="Buscar conversa por nome ou telefone"
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onSearchChange('');
              }}
            />
            {search && (
              <button
                type="button"
                className="icon-btn wa-clear"
                onClick={() => onSearchChange('')}
                aria-label="Limpar busca"
              >
                <IconX />
              </button>
            )}
          </div>
          {manageable.size > 0 && !selection.active && (
            <button
              type="button"
              className="icon-btn wa-select-btn"
              onClick={selection.onStart}
              title="Selecionar conversas"
              aria-label="Selecionar conversas"
            >
              <IconChecks />
            </button>
          )}
        </div>
        {selection.active && (
          <div className="wa-select-bar" role="toolbar" aria-label="Conversas selecionadas">
            <label className="wa-select-all">
              <input
                type="checkbox"
                checked={allChecked}
                disabled={!selectable.length}
                onChange={(e) =>
                  selection.onSetAll(e.target.checked ? new Set(selectable.map((c) => c.id)) : new Set())
                }
              />
              <span>
                {selection.checked.size
                  ? plural(selection.checked.size, 'selecionada', 'selecionadas')
                  : 'Selecionar todas'}
              </span>
            </label>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={!selection.checked.size}
              onClick={selection.onDelete}
            >
              <IconTrash size={15} /> Excluir
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={selection.onCancel}
              aria-label="Cancelar seleção"
            >
              <IconX />
            </button>
          </div>
        )}
        <div className="seg wa-tabs" role="radiogroup" aria-label="Quais conversas mostrar">
          <button
            type="button"
            role="radio"
            aria-checked={tab === 'responderam'}
            onClick={() => onTabChange('responderam')}
          >
            Responderam
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={tab === 'todas'}
            onClick={() => onTabChange('todas')}
          >
            Todas
          </button>
        </div>
        {instances.length > 1 && (
          <div className="wa-chips" role="group" aria-label="Filtrar por número">
            <button
              type="button"
              className="wa-chip"
              aria-pressed={instanceId === null}
              onClick={() => onInstanceChange(null)}
            >
              Todos os números
            </button>
            {instances.map((i) => (
              <button
                key={i.id}
                type="button"
                className="wa-chip"
                aria-pressed={instanceId === i.id}
                onClick={() => onInstanceChange(instanceId === i.id ? null : i.id)}
              >
                <i
                  className="wa-dot"
                  style={{ '--wa-color': instanceColor(i.id) } as CSSProperties}
                  aria-hidden="true"
                />
                {instanceLabel(i)}
                {i.status !== 'open' && <IconWifiOff className="off" aria-label="desconectado" />}
              </button>
            ))}
          </div>
        )}
      </header>

      {!online && (
        <div className="wa-banner" role="status">
          <IconWifiOff /> Sem conexão com o servidor. Tentando reconectar…
        </div>
      )}

      <ul className="wa-conversations" onScroll={onScroll} aria-busy={conversations.loading}>
        {conversations.items.map((c) => (
          <li key={c.id}>
            <ConversationRow
              conversation={c}
              label={labels.get(c.instance.id) ?? instanceLabel(c.instance)}
              selected={c.id === selectedId}
              onSelect={onSelect}
              check={
                selection.active
                  ? manageable.has(c.instance.id)
                    ? selection.checked.has(c.id)
                    : 'disabled'
                  : undefined
              }
              onToggle={selection.onToggle}
            />
          </li>
        ))}
        {conversations.loading &&
          Array.from({ length: 7 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: linhas fixas de carregamento
            <li key={`s${i}`} className="skel wa-skel" aria-hidden="true" />
          ))}
        {!conversations.loading && conversations.items.length === 0 && (
          <li>
            {query ? (
              <Empty title={`Nada encontrado para “${query}”`} icon={<IconSearch size={20} />}>
                <p>
                  {tab === 'responderam'
                    ? 'Procure também na aba Todas.'
                    : 'Confira o nome ou digite parte do telefone.'}
                </p>
              </Empty>
            ) : tab === 'responderam' ? (
              <Empty title="Nenhum lead respondeu ainda" icon={<IconConversas />}>
                <p>Quando alguém responder, a conversa aparece aqui. As demais ficam na aba Todas.</p>
              </Empty>
            ) : (
              <Empty title="Nenhuma conversa ainda" icon={<IconConversas />}>
                <p>As conversas dos números conectados aparecem aqui.</p>
              </Empty>
            )}
          </li>
        )}
      </ul>
    </aside>
  );
}

type RowProps = {
  conversation: ConversationItem;
  label: string;
  selected: boolean;
  onSelect: (id: number) => void;
  /** Modo de seleção: marcada ou não; "disabled" = número que a pessoa não cuida. */
  check?: boolean | 'disabled';
  onToggle: (id: number) => void;
};

/** Só redesenha a linha que mudou (importante com muitas conversas e mensagens chegando o tempo todo). */
const ConversationRow = memo(function ConversationRow({
  conversation: c,
  label,
  selected,
  onSelect,
  check,
  onToggle,
}: RowProps) {
  const unread = c.unreadCount > 0;
  const selecting = check !== undefined;
  return (
    <button
      type="button"
      className={`wa-row${selected && !selecting ? ' selected' : ''}${unread ? ' unread' : ''}${check === true ? ' checked' : ''}`}
      aria-current={(selected && !selecting) || undefined}
      aria-pressed={selecting && check !== 'disabled' ? check === true : undefined}
      disabled={check === 'disabled'}
      title={check === 'disabled' ? 'Só o responsável pelo número ou um administrador exclui' : undefined}
      onClick={() => (selecting ? onToggle(c.id) : onSelect(c.id))}
    >
      {selecting && (
        <span className="wa-check" aria-hidden="true">
          {check === true && <IconCheck size={13} />}
        </span>
      )}
      <ContactAvatar name={c.lead?.label ?? c.contact.name} />
      <span className="wa-row-main">
        <span className="wa-row-top">
          <span className="wa-row-name">{conversationTitle(c)}</span>
          <span className="wa-row-time">{listTime(c.lastMessageAt)}</span>
        </span>
        <span className="wa-row-mid">
          <span className="wa-row-preview">
            {c.lastMessageFromMe && <span className="wa-me">Você:</span>}
            <span>{c.lastMessagePreview || ' '}</span>
          </span>
          {unread && (
            <span className="wa-unread" title={`${c.unreadCount} não lidas`}>
              {c.unreadCount > 99 ? '99+' : c.unreadCount}
            </span>
          )}
        </span>
        <span className="wa-row-meta">
          <span
            className="wa-row-num"
            style={{ '--wa-color': instanceColor(c.instance.id) } as CSSProperties}
          >
            <i aria-hidden="true" />
            {label}
          </span>
          {(c.contact.name || c.lead) && c.contact.phone && (
            <span className="wa-row-phone">{formatPhone(c.contact.phone)}</span>
          )}
        </span>
      </span>
    </button>
  );
});
