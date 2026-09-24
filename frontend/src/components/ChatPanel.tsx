import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, mergeMessages, PAGE_SIZE, type ChatMessage, type ConversationItem } from '../api.ts';
import { contactName, dayLabel, formatPhone, instanceColor, instanceLabel } from '../format.ts';
import { usePolling } from '../usePolling.ts';
import { Composer } from './Composer.tsx';
import { MessageBubble } from './MessageBubble.tsx';

type Props = {
  conversationId: number;
  onBack: () => void;
  onConversationChanged: () => void;
};

export function ChatPanel({ conversationId, onBack, onConversationChanged }: Props) {
  const [conversation, setConversation] = useState<ConversationItem | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true); // acompanha as mensagens novas enquanto a pessoa está no fim do chat
  const olderAnchor = useRef<number | null>(null); // mantém a posição ao carregar mensagens antigas
  const loadingOlder = useRef(false);

  // Zera as não lidas (só no sistema) enquanto a conversa está aberta e a aba do navegador visível.
  const markReadIfNeeded = async (c: ConversationItem) => {
    if (c.unreadCount > 0 && document.visibilityState === 'visible') {
      await api.markRead(c.id);
      onConversationChanged();
    }
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.conversation(conversationId), api.messages(conversationId)])
      .then(([c, list]) => {
        if (cancelled) return;
        setConversation(c);
        setMessages(list);
        setHasOlder(list.length === PAGE_SIZE);
        void markReadIfNeeded(c);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  usePolling(async () => {
    const [c, latest] = await Promise.all([api.conversation(conversationId), api.messages(conversationId)]);
    setConversation(c);
    setMessages((prev) => mergeMessages(prev, latest));
    await markReadIfNeeded(c);
  }, 3_000);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (olderAnchor.current !== null) {
      el.scrollTop = el.scrollHeight - olderAnchor.current;
      olderAnchor.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const loadOlder = async () => {
    const el = listRef.current;
    if (!el || !hasOlder || loadingOlder.current || messages.length === 0) return;
    loadingOlder.current = true;
    try {
      const older = await api.messages(conversationId, messages[0].id);
      olderAnchor.current = el.scrollHeight - el.scrollTop;
      setMessages((prev) => mergeMessages(prev, older));
      setHasOlder(older.length === PAGE_SIZE);
    } finally {
      loadingOlder.current = false;
    }
  };

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 80) void loadOlder();
  };

  const send = async (text: string) => {
    setError(null);
    try {
      const sent = await api.sendText(conversationId, text);
      stickToBottom.current = true;
      setMessages((prev) => mergeMessages(prev, [sent]));
      onConversationChanged();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  };

  if (!conversation) {
    return (
      <main className="chat chat-empty">
        <p>{error ?? 'Carregando…'}</p>
      </main>
    );
  }

  const disconnected = conversation.instance.status !== 'open';

  return (
    <main className="chat">
      <header className="chat-header">
        <button className="back-button" onClick={onBack} aria-label="Voltar para a lista">
          ←
        </button>
        <div className="chat-title">
          <strong>{contactName(conversation.contact)}</strong>
          <span>{formatPhone(conversation.contact.phone)}</span>
        </div>
        <span
          className="instance-badge"
          title="A resposta sai por este número"
          style={{ '--instance-color': instanceColor(conversation.instance.id) } as React.CSSProperties}
        >
          via {instanceLabel(conversation.instance)}
        </span>
      </header>

      {disconnected && (
        <div className="chat-warning">
          ⚠ O número {instanceLabel(conversation.instance)} está desconectado. As respostas não serão enviadas até ele ser
          reconectado.
        </div>
      )}

      <div className="messages" ref={listRef} onScroll={onScroll}>
        {hasOlder && <div className="messages-info">Role para cima para ver mensagens anteriores</div>}
        {messages.map((m, i) => {
          const day = dayLabel(m.sentAt);
          const newDay = i === 0 || dayLabel(messages[i - 1].sentAt) !== day;
          return (
            <Fragment key={m.id}>
              {newDay && <div className="day-separator">{day}</div>}
              <MessageBubble message={m} />
            </Fragment>
          );
        })}
      </div>

      {error && (
        <div className="chat-error" role="alert">
          {error}
          <button onClick={() => setError(null)} aria-label="Fechar aviso">
            ×
          </button>
        </div>
      )}
      <Composer onSend={send} />
    </main>
  );
}
