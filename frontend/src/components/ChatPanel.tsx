import { ArrowDown, ArrowLeft, CircleAlert, MessageSquareText, TriangleAlert, WifiOff, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  mergeMessages,
  PAGE_SIZE,
  type ChatMessage,
  type ConversationItem,
  type InstanceInfo,
  type MessageEvent,
} from '../api.ts';
import { contactName, dayLabel, formatPhone, instanceLabel } from '../format.ts';
import { useOnline, useReconnect, useSocketEvent } from '../socket.ts';
import { Composer } from './Composer.tsx';
import { MessageBubble } from './MessageBubble.tsx';
import { Avatar, EmptyState, InstanceChip, Spinner } from './ui.tsx';

type Props = {
  conversationId: number;
  preview?: ConversationItem; // dados da lista, para o cabeçalho aparecer na hora
  instances: InstanceInfo[];
  onBack: () => void;
};

// Mensagens seguidas do mesmo lado, com menos de 5 minutos entre elas, ficam agrupadas (sem espaço extra).
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

export function ChatPanel({ conversationId, preview, instances, onBack }: Props) {
  const [conversation, setConversation] = useState<ConversationItem | null>(preview ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const [newCount, setNewCount] = useState(0); // mensagens que chegaram enquanto a pessoa lia as antigas
  const online = useOnline();
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true); // acompanha as mensagens novas enquanto a pessoa está no fim do chat
  const olderAnchor = useRef<number | null>(null); // mantém a posição ao carregar mensagens antigas
  const busyOlder = useRef(false);
  const firstLoad = useRef(true);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;

  // Zera as não lidas (só no sistema) enquanto a conversa está aberta e a aba do navegador visível.
  // O backend avisa todas as telas abertas, então a lista se atualiza sozinha.
  const markReadIfNeeded = (c: ConversationItem | null) => {
    if (c && c.unreadCount > 0 && document.visibilityState === 'visible') void api.markRead(c.id).catch(() => {});
  };

  const load = async () => {
    const [c, latest] = await Promise.all([api.conversation(conversationId), api.messages(conversationId)]);
    setConversation(c);
    setMessages((prev) => mergeMessages(prev, latest));
    if (firstLoad.current) setHasOlder(latest.length === PAGE_SIZE);
    firstLoad.current = false;
    setLoaded(true);
    markReadIfNeeded(c);
  };

  useEffect(() => {
    load().catch((e: Error) => setLoadError(e.message));
    // Ao voltar para a aba do navegador, zera as não lidas da conversa aberta.
    const onVisible = () => markReadIfNeeded(conversationRef.current);
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // A tela é recriada ao trocar de conversa (key), então só roda uma vez.
  }, []);

  useReconnect(() => void load().catch(() => {}));

  const receive = (message: ChatMessage, isNew: boolean) => {
    setMessages((prev) => mergeMessages(prev, [message]));
    if (isNew && !message.fromMe && !stickToBottom.current) setNewCount((n) => n + 1);
  };
  useSocketEvent<MessageEvent>('message:new', ({ conversationId: id, message }) => id === conversationId && receive(message, true));
  useSocketEvent<MessageEvent>('message:updated', ({ conversationId: id, message }) => id === conversationId && receive(message, false));
  useSocketEvent<ConversationItem>('conversation:updated', (updated) => {
    if (updated.id !== conversationId) return;
    setConversation(updated);
    markReadIfNeeded(updated);
  });

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

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
    if (!el || !hasOlder || busyOlder.current || messages.length === 0) return;
    busyOlder.current = true;
    setLoadingOlder(true);
    try {
      const older = await api.messages(conversationId, messages[0].id);
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
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
    },
    [],
  );

  const groups = useMemo(() => groupByDay(messages), [messages]);

  if (!conversation) {
    return (
      <section className="chat">
        <div className="chat-placeholder">
          {loadError ? (
            <EmptyState
              icon={CircleAlert}
              title="Não foi possível abrir a conversa"
              action={
                <button className="btn btn-secondary" onClick={onBack}>
                  <ArrowLeft aria-hidden /> Voltar para a lista
                </button>
              }
            >
              {loadError}
            </EmptyState>
          ) : (
            <Spinner />
          )}
        </div>
      </section>
    );
  }

  // Apelido e status do número vêm da lista de números, que é atualizada em tempo real.
  const instance = instances.find((i) => i.id === conversation.instance.id) ?? conversation.instance;
  const label = instanceLabel(instance);
  const hasName = !!conversation.contact.name;

  return (
    <section className="chat" aria-label={`Conversa com ${contactName(conversation.contact)}`}>
      <header className="chat-header">
        <button className="icon-btn chat-back" onClick={onBack} aria-label="Voltar para a lista">
          <ArrowLeft />
        </button>
        <Avatar name={conversation.contact.name} seed={conversation.contact.phone ?? String(conversation.contact.id)} size="sm" />
        <div className="chat-title">
          <strong>{contactName(conversation.contact)}</strong>
          {hasName && conversation.contact.phone && <span>{formatPhone(conversation.contact.phone)}</span>}
        </div>
        <InstanceChip id={instance.id} label={label} prefix="via " pill title={`A resposta sai pelo número ${label}`} />
      </header>

      {!online && (
        <div className="chat-banner offline-chat" role="status">
          <WifiOff aria-hidden />
          Sem conexão com o servidor. Tentando reconectar…
        </div>
      )}
      {instance.status !== 'open' && (
        <div className="chat-banner" role="status">
          <TriangleAlert aria-hidden />
          <span>
            O número <strong>{label}</strong> está desconectado. As respostas só saem depois que ele for reconectado em Números.
          </span>
        </div>
      )}

      <div className="messages-area">
        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          <div className="messages-inner" ref={innerRef}>
            {loadingOlder && (
              <div className="messages-info">
                <Spinner />
              </div>
            )}
            {!loaded && (
              <div className="messages-loading">
                <Spinner />
              </div>
            )}
            {loaded && messages.length === 0 && (
              <EmptyState icon={MessageSquareText} title="Nenhuma mensagem por aqui">
                As mensagens desta conversa aparecem aqui assim que chegarem.
              </EmptyState>
            )}
            {groups.map((group) => (
              <section key={group.day} className="day-group">
                <div className="day-separator">{group.day}</div>
                {group.items.map(({ message, groupStart }) => (
                  <MessageBubble key={message.id} message={message} groupStart={groupStart} />
                ))}
              </section>
            ))}
          </div>
        </div>

        {!nearBottom && (
          <button
            className="scroll-bottom"
            onClick={() => {
              setNewCount(0);
              scrollToBottom(true);
            }}
            aria-label="Ir para as mensagens mais recentes"
          >
            <ArrowDown />
            {newCount > 0 && <span className="unread-badge">{newCount}</span>}
          </button>
        )}
      </div>

      {error && (
        <div className="chat-error" role="alert">
          <CircleAlert aria-hidden />
          <span>{error}</span>
          <button className="icon-btn" onClick={() => setError(null)} aria-label="Fechar aviso">
            <X />
          </button>
        </div>
      )}
      <Composer
        onSendText={(text) => send(() => api.sendText(conversationId, text))}
        onSendFile={(file, caption) => send(() => api.sendFile(conversationId, file, caption))}
        onSendAudio={(audio) => send(() => api.sendAudio(conversationId, audio))}
        onError={setError}
      />
    </section>
  );
}
