import { useState } from 'react';
import { mediaUrl, type ChatMessage } from '../api.ts';
import { timeOf } from '../format.ts';

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

// Imagem/figurinha: carrega só quando aparece na tela. Clicar abre em tamanho real.
function MediaImage({ url, sticker }: { url: string; sticker?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="media-label">{sticker ? '🙂 Figurinha' : '📷 Imagem'} indisponível</div>;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img className={sticker ? 'media-sticker' : 'media-image'} src={url} alt={sticker ? 'Figurinha' : 'Imagem'} loading="lazy" onError={() => setFailed(true)} />
    </a>
  );
}

function MediaContent({ message }: { message: ChatMessage }) {
  const url = mediaUrl(message.id);
  switch (message.type) {
    case 'image':
      return <MediaImage url={url} />;
    case 'sticker':
      return <MediaImage url={url} sticker />;
    case 'audio':
      return <audio className="media-audio" controls preload="none" src={url} />;
    case 'video':
      return <video className="media-video" controls preload="none" src={url} />;
    case 'document':
      return (
        <a className="media-document" href={url} download={message.fileName ?? true}>
          <span aria-hidden>📄</span>
          <span className="media-document-name">{message.fileName ?? 'Documento'}</span>
          <span className="media-document-action">Baixar</span>
        </a>
      );
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

  return (
    <div className={`bubble ${message.fromMe ? 'mine' : 'theirs'} ${message.type === 'sticker' ? 'bubble-sticker' : ''}`}>
      <MediaContent message={message} />
      {message.text && <div className="bubble-text">{message.text}</div>}
      <span className="bubble-meta">
        {timeOf(message.sentAt)}
        {message.fromMe && <StatusTicks status={message.status} />}
      </span>
    </div>
  );
}
