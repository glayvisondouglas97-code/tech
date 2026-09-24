import { useQueryClient } from '@tanstack/react-query';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ChatMessage,
  ConversationItem,
  InstanceInfo,
  MessageEvent,
} from '../../../shared/conversations';
import { errorMessage } from '../../lib/api';
import { plural } from '../../lib/format';
import { useRealtimeOnline, useReconnect, useSocketEvent } from '../../lib/socket';
import { useCanManageNumber } from '../../lib/wa-access';
import {
  canDeleteForEveryone,
  conversationTitle,
  dayLabel,
  formatPhone,
  instanceColor,
  instanceLabel,
  mergeMessages,
  PAGE_SIZE,
  wa,
} from '../../lib/whatsapp';
import {
  IconAlert,
  IconArrowDown,
  IconBack,
  IconChat,
  IconCheck,
  IconChecks,
  IconDots,
  IconMic,
  IconTrash,
  IconWarning,
  IconWifiOff,
  IconX,
} from '../Icons';
import { useToast } from '../Toasts';
import { Confirm, Empty, Menu } from '../ui';
import { Composer } from './Composer';
import { ContactAvatar } from './ContactAvatar';
import { LeadStrip } from './LeadStrip';
import { MessageBubble } from './MessageBubble';

type Props = {
  conversationId: number;
  /** Dados da lista, para o cabeçalho aparecer na hora. */
  preview?: ConversationItem;
  instances: InstanceInfo[];
  onBack: () => void;
  /** A conversa foi excluída (por esta pessoa ou por outra): a tela volta para a lista. */
  onDeleted: () => void;
};

/** Mensagens seguidas do mesmo lado, com menos de 5 minutos entre elas, ficam agrupadas. */
const GROUP_GAP_MS = 5 * 60 * 1000;

type DayGroup = { day: string; items: { message: ChatMessage; groupStart: boolean }[] };

function groupByDay(messages: ChatMessage[]): DayGroup[] {
  const days: DayGroup[] = [];
  let previous: ChatMessage | null = null;
  for (const message of messages) {
    const day = dayLabel(message.sentAt);
    let group = days.at(-1);
    if (!group || group.day !== day) {
      group = { day, items: [] };
      days.push(group);
      previous = null;
    }
    const groupStart =
      !previous ||
      previous.fromMe !== message.fromMe ||
      previous.type === 'reaction' ||
      Date.parse(message.sentAt) - Date.parse(previous.sentAt) > GROUP_GAP_MS;
    group.items.push({ message, groupStart });
    previous = message;
  }
  return days;
}

export function ChatPanel({ conversationId, preview, instances, onBack, onDeleted }: Props) {
  const [conversation, setConversation] = useState<ConversationItem | null>(preview ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const [newCount, setNewCount] = useState(0); // mensagens que chegaram enquanto a pessoa lia as antigas
  const online = useRealtimeOnline();
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true); // acompanha as mensagens novas enquanto a pessoa está no fim do chat
  const olderAnchor = useRef<number | null>(null); // mantém a posição ao carregar mensagens antigas
  const busyOlder = useRef(false);
  const firstLoad = useRef(true);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const qc = useQueryClient();
  const toast = useToast();
  const canManageNumber = useCanManageNumber();
  // Seleção de mensagens para apagar (para mim ou para todos) e exclusão da conversa.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [confirming, setConfirming] = useState<null | 'mim' | 'todos' | 'conversa'>(null);
  const [deleting, setDeleting] = useState(false);
  const stopSelecting = useCallback(() => {
    setSelecting(false);
    setPicked(new Set());
  }, []);
  const togglePicked = useCallback((id: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) stopSelecting();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selecting, stopSelecting]);

  // Apagadas por outra pessoa (ou em outra aba): saem da tela na hora.
  useSocketEvent<{ conversationId: number; ids: number[] }>(
    'message:deleted',
    ({ conversationId: id, ids }) => {
      if (id !== conversationId) return;
      const gone = new Set(ids);
      setMessages((prev) => prev.filter((m) => !gone.has(m.id)));
      setPicked((prev) => new Set([...prev].filter((x) => !gone.has(x))));
    },
  );
  useSocketEvent<{ id: number }>('conversation:deleted', ({ id }) => {
    if (id === conversationId) onDeleted();
  });

  const removeMessages = async (forEveryone: boolean) => {
    setDeleting(true);
    try {
      const r = await wa.deleteMessages(conversationId, [...picked], forEveryone);
      const gone = new Set(r.ids);
      setMessages((prev) => prev.filter((m) => !gone.has(m.id)));
      toast(
        forEveryone
          ? `${plural(r.deleted, 'mensagem apagada', 'mensagens apagadas')} para todos.`
          : `${plural(r.deleted, 'mensagem apagada', 'mensagens apagadas')} do sistema.`,
      );
      if (r.failed) {
        toast(
          `${plural(r.failed, 'mensagem não pôde', 'mensagens não puderam')} ser apagada(s) para todos.`,
          {
            tone: 'warn',
          },
        );
      }
      stopSelecting();
    } catch (e) {
      toast(errorMessage(e), { tone: 'bad' });
    } finally {
      setDeleting(false);
      setConfirming(null);
    }
  };

  const removeConversation = async () => {
    setDeleting(true);
    try {
      await wa.deleteConversations([conversationId]);
      toast('Conversa excluída.');
      onDeleted();
    } catch (e) {
      toast(errorMessage(e), { tone: 'bad' });
      setDeleting(false);
      setConfirming(null);
    }
  };

  // O resultado do lead muda sozinho quando a primeira mensagem sai e quando ele responde:
  // atualiza a faixa do lead e as telas do Chamador.
  const refreshLead = useCallback(() => {
    if (!conversationRef.current?.lead) return;
    for (const key of ['lead', 'queue', 'queue-stats', 'leads', 'dashboard'])
      qc.invalidateQueries({ queryKey: [key] });
  }, [qc]);

  // Zera as não lidas (só no sistema) enquanto a conversa está aberta e a aba do navegador visível.
  const markReadIfNeeded = useCallback((c: ConversationItem | null) => {
    if (c && c.unreadCount > 0 && document.visibilityState === 'visible')
      void wa.markRead(c.id).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    const [c, latest] = await Promise.all([wa.conversation(conversationId), wa.messages(conversationId)]);
    setConversation(c);
    setMessages((prev) => mergeMessages(prev, latest));
    if (firstLoad.current) setHasOlder(latest.length === PAGE_SIZE);
    firstLoad.current = false;
    setLoaded(true);
    markReadIfNeeded(c);
  }, [conversationId, markReadIfNeeded]);

  useEffect(() => {
    load().catch((e) => setLoadError(errorMessage(e)));
    // Ao voltar para a aba do navegador, zera as não lidas da conversa aberta.
    const onVisible = () => markReadIfNeeded(conversationRef.current);
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load, markReadIfNeeded]);

  useReconnect(() => void load().catch(() => {}));

  const receive = (message: ChatMessage, isNew: boolean) => {
    setMessages((prev) => mergeMessages(prev, [message]));
    if (isNew && !message.fromMe && !stickToBottom.current) setNewCount((n) => n + 1);
  };
  useSocketEvent<MessageEvent>('message:new', ({ conversationId: id, message }) => {
    if (id === conversationId) receive(message, true);
  });
  useSocketEvent<MessageEvent>('message:updated', ({ conversationId: id, message }) => {
    if (id === conversationId) receive(message, false);
  });
  useSocketEvent<ConversationItem>('conversation:updated', (updated) => {
    if (updated.id !== conversationId) return;
    setConversation(updated);
    markReadIfNeeded(updated);
    if (updated.lead) void qc.invalidateQueries({ queryKey: ['lead', updated.lead.id] });
  });

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reage às mensagens e à primeira carga
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (olderAnchor.current !== null) {
      el.scrollTop = el.scrollHeight - olderAnchor.current;
      olderAnchor.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, loaded]);

  // Imagens que terminam de carregar, teclado do celular abrindo, caixa de texto crescendo:
  // se a pessoa estava no fim do chat, continua no fim.
  // biome-ignore lint/correctness/useExhaustiveDependencies: liga o observador quando a área aparece
  useEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current && olderAnchor.current === null) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [loaded]);

  const loadOlder = async () => {
    const el = scrollRef.current;
    const first = messages[0];
    if (!el || !hasOlder || busyOlder.current || !first) return;
    busyOlder.current = true;
    setLoadingOlder(true);
    try {
      const older = await wa.messages(conversationId, first.id);
      olderAnchor.current = el.scrollHeight - el.scrollTop;
      setMessages((prev) => mergeMessages(prev, older));
      setHasOlder(older.length === PAGE_SIZE);
    } catch {
      // tenta de novo na próxima rolagem
    } finally {
      busyOlder.current = false;
      setLoadingOlder(false);
    }
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance < 80;
    const near = distance < 300;
    if (near !== nearBottom) setNearBottom(near);
    if (stickToBottom.current && newCount) setNewCount(0);
    if (el.scrollTop < 200) void loadOlder();
  };

  // Texto, arquivo ou áudio: a mensagem enviada entra no chat; se falhar, mostra o aviso.
  const send = useCallback(
    async (request: () => Promise<ChatMessage>) => {
      setError(null);
      try {
        const sent = await request();
        stickToBottom.current = true;
        setMessages((prev) => mergeMessages(prev, [sent]));
        refreshLead();
      } catch (e) {
        setError(errorMessage(e));
        throw e;
      }
    },
    [refreshLead],
  );

  const groups = useMemo(() => groupByDay(messages), [messages]);

  if (!conversation) {
    return (
      <section className="wa-chat">
        <div className="wa-chat-center">
          {loadError ? (
            <Empty title="Não foi possível abrir a conversa" icon={<IconAlert />}>
              <p>{loadError}</p>
              <button type="button" className="btn btn-line" onClick={onBack}>
                <IconBack size={16} /> Voltar para a lista
              </button>
            </Empty>
          ) : (
            <span className="spinner" />
          )}
        </div>
      </section>
    );
  }

  // Apelido e status do número vêm da lista de números, que é atualizada em tempo real.
  const instance = instances.find((i) => i.id === conversation.instance.id) ?? conversation.instance;
  const label = instanceLabel(instance);
  const name = conversationTitle(conversation);
  const canDelete = canManageNumber(instances.find((i) => i.id === conversation.instance.id));
  const pickedMessages = messages.filter((m) => picked.has(m.id));
  const forEveryoneOk = pickedMessages.length > 0 && pickedMessages.every(canDeleteForEveryone);

  return (
    <section className="wa-chat" aria-label={`Conversa com ${name}`}>
      <header className="wa-chat-head">
        <button type="button" className="icon-btn wa-back" onClick={onBack} aria-label="Voltar para a lista">
          <IconBack />
        </button>
        <ContactAvatar name={conversation.lead?.label ?? conversation.contact.name} />
        <div className="wa-chat-title">
          <b>{name}</b>
          {(conversation.contact.name || conversation.lead) && conversation.contact.phone && (
            <span>{formatPhone(conversation.contact.phone)}</span>
          )}
        </div>
        <span
          className="wa-via"
          title={`A resposta sai pelo número ${label}`}
          style={{ '--wa-color': instanceColor(instance.id) } as CSSProperties}
        >
          <i aria-hidden="true" />
          <span>via {label}</span>
        </span>
        {canDelete && (
          <Menu label="Mais opções da conversa" icon={<IconDots />}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setSelecting(true);
                setPicked(new Set());
              }}
            >
              <IconChecks /> Selecionar mensagens
            </button>
            <hr />
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => setConfirming('conversa')}
            >
              <IconTrash /> Excluir conversa
            </button>
          </Menu>
        )}
      </header>

      {conversation.lead && <LeadStrip leadId={conversation.lead.id} label={conversation.lead.label} />}

      {!online && (
        <div className="wa-banner wa-offline-chat" role="status">
          <IconWifiOff /> Sem conexão com o servidor. Tentando reconectar…
        </div>
      )}
      {instance.status !== 'open' && (
        <div className="wa-banner" role="status">
          <IconWarning />
          <span>
            O número <b>{label}</b> está desconectado. As respostas só saem depois que ele for reconectado em
            Números.
          </span>
        </div>
      )}

      <div className="wa-messages-area">
        <div className="wa-messages" ref={scrollRef} onScroll={onScroll}>
          <div className="wa-messages-inner" ref={innerRef}>
            {loadingOlder && (
              <div className="wa-messages-info">
                <span className="spinner" />
              </div>
            )}
            {!loaded && (
              <div className="wa-chat-center">
                <span className="spinner" />
              </div>
            )}
            {loaded &&
              messages.length === 0 &&
              (conversation.lead ? (
                <Empty title="Conversa nova" icon={<IconMic />}>
                  <p>
                    Grave um áudio no microfone ou escreva a primeira mensagem. Ela sai pelo número{' '}
                    <b>{label}</b>.
                  </p>
                </Empty>
              ) : (
                <Empty title="Nenhuma mensagem por aqui" icon={<IconChat />}>
                  <p>As mensagens desta conversa aparecem aqui assim que chegarem.</p>
                </Empty>
              ))}
            {groups.map((group) => (
              <section key={group.day} className="wa-day">
                <div className="wa-day-label">{group.day}</div>
                {group.items.map(({ message, groupStart }) =>
                  selecting ? (
                    <SelectableMessage
                      key={message.id}
                      message={message}
                      groupStart={groupStart}
                      checked={picked.has(message.id)}
                      onToggle={togglePicked}
                    />
                  ) : (
                    <MessageBubble key={message.id} message={message} groupStart={groupStart} />
                  ),
                )}
              </section>
            ))}
          </div>
        </div>
        {!nearBottom && (
          <button
            type="button"
            className="wa-to-bottom"
            onClick={() => {
              setNewCount(0);
              scrollToBottom(true);
            }}
            aria-label="Ir para as mensagens mais recentes"
          >
            <IconArrowDown />
            {newCount > 0 && <span className="wa-unread">{newCount}</span>}
          </button>
        )}
      </div>

      {error && (
        <div className="wa-error" role="alert">
          <IconAlert />
          <span>{error}</span>
          <button type="button" className="icon-btn" onClick={() => setError(null)} aria-label="Fechar aviso">
            <IconX />
          </button>
        </div>
      )}
      {selecting ? (
        <div className="wa-select-actions" role="toolbar" aria-label="Mensagens selecionadas">
          <button type="button" className="icon-btn" onClick={stopSelecting} aria-label="Cancelar seleção">
            <IconX />
          </button>
          <b className="grow">
            {picked.size ? plural(picked.size, 'selecionada', 'selecionadas') : 'Toque nas mensagens'}
          </b>
          <button
            type="button"
            className="btn btn-line btn-sm"
            disabled={!picked.size}
            onClick={() => setConfirming('mim')}
          >
            Apagar para mim
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={!forEveryoneOk}
            title={
              forEveryoneOk ? undefined : 'Para todos, só mensagens enviadas pelo número nas últimas 48 horas'
            }
            onClick={() => setConfirming('todos')}
          >
            Apagar para todos
          </button>
        </div>
      ) : (
        <Composer
          onSendText={(text) => send(() => wa.sendText(conversationId, text))}
          onSendFile={(file, caption) => send(() => wa.sendFile(conversationId, file, caption))}
          onSendAudio={(audio) => send(() => wa.sendAudio(conversationId, audio))}
          onError={setError}
        />
      )}

      <Confirm
        open={confirming === 'mim'}
        title={`Apagar ${plural(picked.size, 'mensagem', 'mensagens')} para você?`}
        confirmLabel="Apagar para mim"
        danger
        busy={deleting}
        onClose={() => setConfirming(null)}
        onConfirm={() => void removeMessages(false)}
      >
        <p>
          Somem do sistema para toda a equipe, com os áudios, fotos e documentos. O contato continua vendo no
          WhatsApp dele.
        </p>
      </Confirm>
      <Confirm
        open={confirming === 'todos'}
        title={`Apagar ${plural(picked.size, 'mensagem', 'mensagens')} para todos?`}
        confirmLabel="Apagar para todos"
        danger
        busy={deleting}
        onClose={() => setConfirming(null)}
        onConfirm={() => void removeMessages(true)}
      >
        <p>
          Somem do WhatsApp do contato (lá aparece "Mensagem apagada") e do sistema. Não dá para desfazer.
        </p>
      </Confirm>
      <Confirm
        open={confirming === 'conversa'}
        title="Excluir esta conversa?"
        confirmLabel="Excluir conversa"
        danger
        busy={deleting}
        onClose={() => setConfirming(null)}
        onConfirm={() => void removeConversation()}
      >
        <p>
          A conversa e as mensagens somem do sistema, com os áudios, fotos e documentos. No WhatsApp do
          celular continuam. Se o contato escrever de novo, a conversa volta só com as mensagens novas.
        </p>
      </Confirm>
    </section>
  );
}

/** Mensagem no modo de seleção: toque para marcar (o conteúdo não reage ao clique). */
function SelectableMessage({
  message,
  groupStart,
  checked,
  onToggle,
}: {
  message: ChatMessage;
  groupStart: boolean;
  checked: boolean;
  onToggle: (id: number) => void;
}) {
  return (
    <div
      className={`wa-sel-row${checked ? ' on' : ''}`}
      role="checkbox"
      aria-checked={checked}
      aria-label={`${message.fromMe ? 'Enviada' : 'Recebida'} às ${new Date(message.sentAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}${message.text ? `: ${message.text.slice(0, 60)}` : ''}`}
      tabIndex={0}
      onClick={() => onToggle(message.id)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onToggle(message.id);
        }
      }}
    >
      <span className="wa-check" aria-hidden="true">
        {checked && <IconCheck size={13} />}
      </span>
      <div className="wa-sel-msg" inert>
        <MessageBubble message={message} groupStart={groupStart} />
      </div>
    </div>
  );
}
