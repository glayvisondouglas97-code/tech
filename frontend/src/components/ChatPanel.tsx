import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  api,
  mergeMessages,
  PAGE_SIZE,
  type ChatMessage,
  type ConversationItem,
  type InstanceInfo,
  type MessageEvent,
} from '../api.ts';
import { contactName, dayLabel, formatPhone, instanceColor, instanceLabel } from '../format.ts';
import { useReconnect, useSocketEvent } from '../socket.ts';
import { Composer } from './Composer.tsx';
import { MessageBubble } from './MessageBubble.tsx';

type Props = {
  conversationId: number;
  instances: InstanceInfo[];
  onBack: () => void;
};

export function ChatPanel({ conversationId, instances, onBack }: Props) {
  const [conversation, setConversation] = useState<ConversationItem | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true); // acompanha as mensagens novas enquanto a pessoa está no fim do chat
  const olderAnchor = useRef<number | null>(null); // mantém a posição ao carregar mensagens antigas
  const loadingOlder = useRef(false);
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
    if (conversationRef.current === null) setHasOlder(latest.length === PAGE_SIZE);
    markReadIfNeeded(c);
  };

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
    // Ao voltar para a aba do navegador, zera as não lidas da conversa aberta.
    const onVisible = () => markReadIfNeeded(conversationRef.current);
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // A tela é recriada ao trocar de conversa (key), então só roda uma vez.
  }, []);

  useReconnect(() => void load().catch(() => {}));

  useSocketEvent<MessageEvent>('message:new', ({ conversationId: id, message }) => {
    if (id === conversationId) setMessages((prev) => mergeMessages(prev, [message]));
  });
  useSocketEvent<MessageEvent>('message:updated', ({ conversationId: id, message }) => {
    if (id === conversationId) setMessages((prev) => mergeMessages(prev, [message]));
  });
  useSocketEvent<ConversationItem>('conversation:updated', (updated) => {
    if (updated.id !== conversationId) return;
    setConversation(updated);
    markReadIfNeeded(updated);
  });

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

  // Texto, arquivo ou áudio: a mensagem enviada entra no chat; se falhar, mostra o aviso.
  const send = async (request: () => Promise<ChatMessage>) => {
    setError(null);
    try {
      const sent = await request();
      stickToBottom.current = true;
      setMessages((prev) => mergeMessages(prev, [sent]));
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

  // Apelido e status do número vêm da lista de números, que é atualizada em tempo real.
  const instance = instances.find((i) => i.id === conversation.instance.id) ?? conversation.instance;
  const disconnected = instance.status !== 'open';

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
          via {instanceLabel(instance)}
        </span>
      </header>

      {disconnected && (
        <div className="chat-warning">
          ⚠ O número {instanceLabel(instance)} está desconectado. As respostas não serão enviadas até ele ser
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
      <Composer
        onSendText={(text) => send(() => api.sendText(conversationId, text))}
        onSendFile={(file, caption) => send(() => api.sendFile(conversationId, file, caption))}
        onSendAudio={(audio) => send(() => api.sendAudio(conversationId, audio))}
        onError={setError}
      />
    </main>
  );
}
