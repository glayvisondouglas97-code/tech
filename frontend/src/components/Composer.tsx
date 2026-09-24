import { useLayoutEffect, useRef, useState } from 'react';

// Caixa de texto do chat. Enter envia; Shift+Enter quebra linha.
export function Composer({ onSend }: { onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A caixa cresce com o texto, até um limite.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await onSend(value);
      setText('');
    } catch {
      // o aviso de erro é mostrado pelo chat; o texto fica na caixa para tentar de novo
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={inputRef}
        rows={1}
        value={text}
        placeholder="Digite uma mensagem"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        autoFocus
      />
      <button type="submit" disabled={!text.trim() || sending}>
        {sending ? 'Enviando…' : 'Enviar'}
      </button>
    </form>
  );
}
