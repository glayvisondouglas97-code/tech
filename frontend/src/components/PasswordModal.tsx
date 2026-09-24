import { useEffect, useState } from 'react';
import { api } from '../api.ts';

export function PasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    setError(null);
    if (next !== confirm) return setError('A confirmação não é igual à senha nova');
    setSaving(true);
    try {
      await api.changePassword(current, next);
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Minha senha" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Minha senha</h2>
          <button className="link-button" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>
        {done ? (
          <p className="modal-status ok">✅ Senha trocada. Os seus logins em outros computadores foram encerrados.</p>
        ) : (
          <form
            className="stack-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label>
              Senha atual
              <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus />
            </label>
            <label>
              Senha nova (mínimo 8 caracteres)
              <input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
            </label>
            <label>
              Repita a senha nova
              <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? 'Salvando…' : 'Trocar senha'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
