import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MAX_UPLOAD_BYTES } from '../api.ts';

type Props = {
  onSendText: (text: string) => Promise<void>;
  onSendFile: (file: File, caption: string) => Promise<void>;
  onSendAudio: (audio: Blob) => Promise<void>;
  onError: (message: string) => void;
};

const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

// Caixa do chat: texto (Enter envia, Shift+Enter quebra linha), anexo (📎) e áudio gravado (🎤).
export function Composer({ onSendText, onSendFile, onSendAudio, onError }: Props) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorder = useAudioRecorder(onError);

  // A caixa cresce com o texto, até um limite.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const run = async (task: () => Promise<void>, onSuccess: () => void) => {
    setSending(true);
    try {
      await task();
      onSuccess();
    } catch {
      // o aviso de erro é mostrado pelo chat; o conteúdo fica para tentar de novo
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const submit = () => {
    if (sending) return;
    if (file) {
      void run(() => onSendFile(file, text.trim()), () => {
        setFile(null);
        setText('');
      });
    } else if (text.trim()) {
      void run(() => onSendText(text.trim()), () => setText(''));
    }
  };

  const pickFile = (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > MAX_UPLOAD_BYTES) {
      onError(`O arquivo tem ${formatSize(picked.size)}. O máximo é ${formatSize(MAX_UPLOAD_BYTES)}.`);
      return;
    }
    setFile(picked);
    inputRef.current?.focus();
  };

  const sendRecording = async () => {
    const audio = await recorder.stop();
    if (audio) void run(() => onSendAudio(audio), () => {});
  };

  if (recorder.recording) {
    return (
      <div className="composer recording">
        <button type="button" className="icon-button" onClick={recorder.cancel} aria-label="Cancelar gravação" title="Cancelar">
          🗑
        </button>
        <span className="recording-indicator">
          <span className="recording-dot" aria-hidden /> Gravando {formatDuration(recorder.seconds)}
        </span>
        <button type="button" className="send-button" onClick={() => void sendRecording()}>
          Enviar áudio
        </button>
      </div>
    );
  }

  const canSend = !!file || !!text.trim();

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {file && (
        <div className="attachment">
          <span className="attachment-name">
            {file.type.startsWith('image/') ? '📷' : '📄'} {file.name} <small>({formatSize(file.size)})</small>
          </span>
          <button type="button" className="icon-button" onClick={() => setFile(null)} aria-label="Remover anexo">
            ×
          </button>
        </div>
      )}
      <div className="composer-row">
        <button
          type="button"
          className="icon-button"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Anexar imagem ou documento"
          title="Anexar imagem ou documento"
          disabled={sending}
        >
          📎
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
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          autoFocus
        />
        {canSend || sending ? (
          <button type="submit" className="send-button" disabled={sending}>
            {sending ? 'Enviando…' : 'Enviar'}
          </button>
        ) : (
          <button type="button" className="icon-button mic-button" onClick={() => void recorder.start()} aria-label="Gravar áudio" title="Gravar áudio">
            🎤
          </button>
        )}
      </div>
    </form>
  );
}

// Grava áudio pelo microfone do navegador (WebM/Opus no Chrome e Edge; MP4 no Safari).
function useAudioRecorder(onError: (message: string) => void) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const release = () => {
    mediaRecorder.current?.stream.getTracks().forEach((track) => track.stop());
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
  useEffect(() => () => mediaRecorder.current?.stream.getTracks().forEach((track) => track.stop()), []);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      onError('Este navegador não permite gravar áudio aqui. O sistema precisa estar em https ou em localhost.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
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

  // Para a gravação e devolve o áudio (ou null se ficou vazio).
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
