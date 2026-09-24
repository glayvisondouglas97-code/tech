import { CircleCheckBig } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api.ts';
import { FormError, Modal, Spinner } from './ui.tsx';

export function PasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

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

  if (done) {
    return (
      <Modal title="Minha senha" onClose={onClose}>
        <div className="success-state">
          <span className="empty-icon" aria-hidden>
            <CircleCheckBig />
          </span>
          <strong>Senha trocada</strong>
          <p>Os seus logins em outros aparelhos foram encerrados.</p>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
            Pronto
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Minha senha" description="Os seus logins em outros aparelhos serão encerrados." onClose={onClose}>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span className="field-label">Senha atual</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span className="field-label">Senha nova (mínimo 8 caracteres)</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span className="field-label">Repita a senha nova</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </label>
        {error && <FormError>{error}</FormError>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving && <Spinner />} Trocar senha
          </button>
        </div>
      </form>
    </Modal>
  );
}
