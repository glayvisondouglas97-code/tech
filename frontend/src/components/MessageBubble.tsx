import type { ChatMessage } from '../api.ts';
import { timeOf } from '../format.ts';

// Rótulo das mídias. Os players (áudio, imagem, documento) chegam na Fase 6.
const MEDIA_LABEL: Partial<Record<ChatMessage['type'], string>> = {
  audio: '🎤 Mensagem de voz',
  image: '📷 Imagem',
  video: '🎥 Vídeo',
  sticker: '🙂 Figurinha',
};

function StatusTicks({ status }: { status: string | null }) {
  switch (status) {
    case 'PENDING':
      return <span className="ticks" title="Enviando">🕓</span>;
    case 'SERVER_ACK':
      return <span className="ticks" title="Enviada">✓</span>;
    case 'DELIVERY_ACK':
      return <span className="ticks" title="Entregue">✓✓</span>;
    case 'READ':
    case 'PLAYED':
      return <span className="ticks read" title={status === 'PLAYED' ? 'Ouvida' : 'Lida'}>✓✓</span>;
    case 'ERROR':
      return <span className="ticks error" title="Erro no envio">!</span>;
    default:
      return null;
  }
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.type === 'reaction') {
    return (
      <div className={`reaction ${message.fromMe ? 'mine' : 'theirs'}`}>
        {message.fromMe ? 'Você reagiu' : 'Reagiu'} {message.text}
      </div>
    );
  }

  const label = message.type === 'document' ? `📄 ${message.fileName ?? 'Documento'}` : MEDIA_LABEL[message.type];

  return (
    <div className={`bubble ${message.fromMe ? 'mine' : 'theirs'}`}>
      {label && <div className="media-label">{label}</div>}
      {message.text && <div className="bubble-text">{message.text}</div>}
      <span className="bubble-meta">
        {timeOf(message.sentAt)}
        {message.fromMe && <StatusTicks status={message.status} />}
      </span>
    </div>
  );
}
