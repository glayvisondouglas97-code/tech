import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MAX_UPLOAD_BYTES } from '../../../shared/conversations';
import { formatDuration, formatSize, isTouchDevice } from '../../lib/whatsapp';
import { IconClip, IconDoc, IconMic, IconSend, IconTrash, IconX } from '../Icons';

type Props = {
  onSendText: (text: string) => Promise<void>;
  onSendFile: (file: File, caption: string) => Promise<void>;
  onSendAudio: (audio: Blob) => Promise<void>;
  onError: (message: string) => void;
};

/**
 * Caixa do chat: texto, anexo (imagem ou documento) e áudio gravado no navegador.
 * No computador, Enter envia e Shift+Enter quebra a linha. No celular, Enter quebra a linha e o botão envia.
 */
export function Composer({ onSendText, onSendFile, onSendAudio, onError }: Props) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorder = useAudioRecorder(onError);
  const thumbnail = useObjectUrl(file?.type.startsWith('image/') ? file : null);

  // A caixa cresce com o texto, até um limite.
  // biome-ignore lint/correctness/useExhaustiveDependencies: recalcula a altura quando o texto muda
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const focusInput = () => {
    if (!isTouchDevice) inputRef.current?.focus(); // no celular, não abre o teclado sozinho
  };

  const run = async (task: () => Promise<void>, onSuccess: () => void) => {
    setSending(true);
    try {
      await task();
      onSuccess();
    } catch {
      // o aviso de erro é mostrado pelo chat; o conteúdo fica para tentar de novo
    } finally {
      setSending(false);
      focusInput();
    }
  };

  const submit = () => {
    if (sending) return;
    if (file) {
      void run(
        () => onSendFile(file, text.trim()),
        () => {
          setFile(null);
          setText('');
        },
      );
    } else if (text.trim()) {
      void run(
        () => onSendText(text.trim()),
        () => setText(''),
      );
    }
  };

  const pickFile = (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > MAX_UPLOAD_BYTES) {
      onError(`O arquivo tem ${formatSize(picked.size)}. O máximo é ${formatSize(MAX_UPLOAD_BYTES)}.`);
      return;
    }
    setFile(picked);
    focusInput();
  };

  const sendRecording = async () => {
    const audio = await recorder.stop();
    if (audio)
      void run(
        () => onSendAudio(audio),
        () => {},
      );
  };

  if (recorder.recording) {
    return (
      <div className="wa-composer">
        <div className="wa-composer-row">
          <div className="wa-recording">
            <button
              type="button"
              className="icon-btn"
              onClick={recorder.cancel}
              aria-label="Descartar gravação"
              title="Descartar"
            >
              <IconTrash />
            </button>
            <span className="wa-rec-indicator" role="status">
              <span className="wa-rec-dot" aria-hidden="true" />
              {formatDuration(recorder.seconds)}
              <span className="wa-wave" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className="vh">Gravando áudio</span>
            </span>
          </div>
          <button
            type="button"
            className="wa-round"
            onClick={() => void sendRecording()}
            aria-label="Enviar áudio"
            title="Enviar áudio"
          >
            <IconSend />
          </button>
        </div>
      </div>
    );
  }

  const canSend = !!file || !!text.trim();

  return (
    <form
      className="wa-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {file && (
        <div className="wa-attachment">
          {thumbnail ? (
            <img className="wa-attachment-thumb" src={thumbnail} alt="" />
          ) : (
            <span className="wa-doc-ic" aria-hidden="true">
              <IconDoc size={20} />
            </span>
          )}
          <span className="wa-attachment-name">
            <b>{file.name}</b>
            <small>{formatSize(file.size)}</small>
          </span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setFile(null)}
            aria-label="Remover anexo"
            disabled={sending}
          >
            <IconX />
          </button>
        </div>
      )}
      <div className="wa-composer-row">
        <div className="wa-field">
          <button
            type="button"
            className="icon-btn"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Anexar imagem ou documento"
            title="Anexar imagem ou documento"
            disabled={sending}
          >
            <IconClip />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(e) => {
              pickFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            placeholder={file ? 'Legenda (opcional)' : 'Digite uma mensagem'}
            aria-label="Mensagem"
            enterKeyHint={isTouchDevice ? 'enter' : 'send'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !isTouchDevice && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            autoFocus={!isTouchDevice}
          />
        </div>
        {canSend || sending ? (
          <button type="submit" className="wa-round" disabled={sending} aria-label="Enviar" title="Enviar">
            {sending ? <span className="spinner" /> : <IconSend />}
          </button>
        ) : (
          <button
            type="button"
            className="wa-round"
            onClick={() => void recorder.start()}
            aria-label="Gravar áudio"
            title="Gravar áudio"
          >
            <IconMic />
          </button>
        )}
      </div>
    </form>
  );
}

/** Endereço temporário para mostrar a miniatura da imagem escolhida (liberado ao trocar/remover). */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [blob]);
  return url;
}

/** Grava áudio pelo microfone do navegador (WebM/Opus no Chrome e Edge; MP4 no Safari). */
export function useAudioRecorder(onError: (message: string) => void) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const release = () => {
    for (const track of mediaRecorder.current?.stream.getTracks() ?? []) track.stop();
    mediaRecorder.current = null;
    setRecording(false);
  };

  useEffect(() => {
    if (!recording) return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  // Se a pessoa trocar de conversa no meio da gravação, o microfone é desligado.
  useEffect(
    () => () => {
      for (const track of mediaRecorder.current?.stream.getTracks() ?? []) track.stop();
    },
    [],
  );

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      onError(
        'Este navegador não permite gravar áudio aqui. O sistema precisa estar em https ou em localhost.',
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) =>
        MediaRecorder.isTypeSupported(t),
      );
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      rec.start();
      mediaRecorder.current = rec;
      setRecording(true);
    } catch (error) {
      const name = (error as DOMException).name;
      onError(
        name === 'NotAllowedError'
          ? 'Permita o uso do microfone para este site (ícone de cadeado na barra de endereço) e tente de novo.'
          : 'Não foi possível acessar o microfone.',
      );
    }
  };

  /** Para a gravação e devolve o áudio (ou null se ficou vazio). */
  const stop = () =>
    new Promise<Blob | null>((resolve) => {
      const rec = mediaRecorder.current;
      if (!rec) return resolve(null);
      rec.onstop = () => {
        const audio = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' });
        release();
        resolve(audio.size > 0 ? audio : null);
      };
      rec.stop();
    });

  const cancel = () => {
    const rec = mediaRecorder.current;
    if (rec) {
      rec.onstop = null;
      rec.stop();
    }
    release();
  };

  return { recording, seconds, start, stop, cancel };
}
