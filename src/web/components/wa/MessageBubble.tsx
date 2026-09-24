import { type CSSProperties, memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatMessage } from '../../../shared/conversations';
import { formatDuration, mediaUrl, timeOf } from '../../lib/whatsapp';
import {
  IconAlert,
  IconCheck,
  IconChecks,
  IconClock,
  IconDoc,
  IconDownload,
  IconImageOff,
  IconPause,
  IconPlay,
  IconX,
} from '../Icons';

function StatusTicks({ status }: { status: string | null }) {
  switch (status) {
    case 'PENDING':
      return (
        <span className="wa-ticks" title="Enviando">
          <IconClock size={13} aria-label="Enviando" />
        </span>
      );
    case 'SERVER_ACK':
      return (
        <span className="wa-ticks" title="Enviada">
          <IconCheck size={15} aria-label="Enviada" />
        </span>
      );
    case 'DELIVERY_ACK':
      return (
        <span className="wa-ticks" title="Entregue">
          <IconChecks aria-label="Entregue" />
        </span>
      );
    case 'READ':
    case 'PLAYED':
      return (
        <span className="wa-ticks read" title={status === 'PLAYED' ? 'Ouvida' : 'Lida'}>
          <IconChecks aria-label={status === 'PLAYED' ? 'Ouvida' : 'Lida'} />
        </span>
      );
    case 'ERROR':
      return (
        <span className="wa-ticks error" title="Erro no envio">
          <IconAlert size={14} aria-label="Erro no envio" />
        </span>
      );
    default:
      return null;
  }
}

function Unavailable({ label }: { label: string }) {
  return (
    <div className="wa-media-off">
      <IconImageOff />
      {label} indisponível
    </div>
  );
}

/** Imagem em tela cheia. Fecha com Esc, com o X ou tocando fora da imagem. */
function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="wa-lightbox" role="dialog" aria-modal="true" aria-label="Imagem">
      <div className="wa-lightbox-bar">
        <a className="icon-btn" href={url} download aria-label="Baixar imagem" title="Baixar">
          <IconDownload />
        </a>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar">
          <IconX />
        </button>
      </div>
      <div
        className="wa-lightbox-stage"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <img src={url} alt="Imagem em tamanho real" />
      </div>
    </div>,
    document.body,
  );
}

/** Imagem/figurinha: só carrega quando aparece na tela. Tocar abre em tela cheia. */
function MediaImage({ url, sticker }: { url: string; sticker?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  if (failed) return <Unavailable label={sticker ? 'Figurinha' : 'Imagem'} />;
  return (
    <>
      <img
        className={sticker ? 'wa-sticker' : 'wa-image'}
        src={url}
        alt={sticker ? 'Figurinha' : 'Imagem'}
        loading="lazy"
        decoding="async"
        onClick={() => setOpen(true)}
        onError={() => setFailed(true)}
      />
      {open && <Lightbox url={url} onClose={() => setOpen(false)} />}
    </>
  );
}

const RATES = [1, 1.5, 2];

/** Player de mensagem de voz: tocar/pausar, barra de progresso e velocidade (1x, 1,5x, 2x). */
function AudioPlayer({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0); // 0 = ainda desconhecida
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);

  const readDuration = () => {
    const value = audioRef.current?.duration ?? 0;
    if (Number.isFinite(value) && value > 0) setDuration(value);
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) return audio.pause();
    // Só um áudio tocando por vez.
    for (const other of document.querySelectorAll('audio')) if (other !== audio) other.pause();
    audio.playbackRate = rate;
    void audio.play().catch(() => setFailed(true));
  };

  const changeRate = () => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  if (failed) return <Unavailable label="Áudio" />;
  const progress = duration ? Math.min(100, (current / duration) * 100) : 0;
  return (
    <div className="wa-audio">
      <button
        type="button"
        className="wa-audio-play"
        onClick={toggle}
        aria-label={playing ? 'Pausar' : 'Ouvir'}
      >
        {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
      </button>
      <div className="wa-audio-track">
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={duration ? Math.min(current, duration) : 0}
          disabled={!duration}
          aria-label="Posição do áudio"
          style={{ '--progress': `${progress}%` } as CSSProperties}
          onChange={(e) => {
            const time = Number(e.target.value);
            if (audioRef.current) audioRef.current.currentTime = time;
            setCurrent(time);
          }}
        />
        <span className="wa-audio-time">{formatDuration(playing || current > 0 ? current : duration)}</span>
      </div>
      <button type="button" className="wa-audio-rate" onClick={changeRate} aria-label={`Velocidade ${rate}x`}>
        {String(rate).replace('.', ',')}×
      </button>
      {/* biome-ignore lint/a11y/useMediaCaption: mensagem de voz do WhatsApp não tem legenda */}
      <audio
        ref={audioRef}
        className="wa-audio-el"
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
          readDuration();
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={readDuration}
        onDurationChange={readDuration}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function extensionOf(message: ChatMessage): string {
  const fromName = message.fileName?.match(/\.([a-z0-9]{1,5})$/i)?.[1];
  const fromMime = message.mediaMime?.split('/')[1]?.split(/[;+.-]/)[0];
  return (fromName ?? fromMime ?? 'arquivo').toUpperCase();
}

function MediaContent({ message }: { message: ChatMessage }) {
  const url = mediaUrl(message.id);
  switch (message.type) {
    case 'image':
      return <MediaImage url={url} />;
    case 'sticker':
      return <MediaImage url={url} sticker />;
    case 'audio':
      return <AudioPlayer url={url} />;
    case 'video':
      // biome-ignore lint/a11y/useMediaCaption: vídeo recebido pelo WhatsApp não tem legenda
      return <video className="wa-video" controls preload="metadata" playsInline src={url} />;
    case 'document':
      return (
        <a className="wa-doc" href={url} download={message.fileName ?? true}>
          <span className="wa-doc-ic" aria-hidden="true">
            <IconDoc size={20} />
          </span>
          <span className="wa-doc-info">
            <span className="wa-doc-name">{message.fileName ?? 'Documento'}</span>
            <small>{extensionOf(message)}</small>
          </span>
          <span className="wa-doc-down" aria-hidden="true">
            <IconDownload />
          </span>
        </a>
      );
    default:
      return null;
  }
}

const MEDIA_BOX = new Set(['image', 'video', 'sticker', 'document']);

export const MessageBubble = memo(function MessageBubble({
  message,
  groupStart,
}: {
  message: ChatMessage;
  groupStart: boolean;
}) {
  if (message.type === 'reaction') {
    return (
      <div className={`wa-reaction${message.fromMe ? ' mine' : ''}`}>
        {message.fromMe ? 'Você reagiu' : 'Reagiu'} {message.text}
      </div>
    );
  }
  // Documento cujo "texto" é só o próprio nome do arquivo: não repete.
  const text = message.type === 'document' && message.text === message.fileName ? null : message.text;
  const classes = [
    'wa-bubble',
    message.fromMe ? 'mine' : 'theirs',
    groupStart && 'group-start',
    MEDIA_BOX.has(message.type) && 'has-media',
    message.type === 'sticker' && 'sticker',
  ];
  return (
    <div className={classes.filter(Boolean).join(' ')}>
      <MediaContent message={message} />
      {(text || message.type === 'text') && (
        <div className="wa-text">
          {text}
          <span className="wa-meta-space" aria-hidden="true" />
        </div>
      )}
      <span className="wa-meta">
        {timeOf(message.sentAt)}
        {message.fromMe && <StatusTicks status={message.status} />}
      </span>
    </div>
  );
});
