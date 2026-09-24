import { type FormEvent, useState } from 'react';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '../../shared/roles';
import { IconMonitor, IconMoon, IconSun } from '../components/Icons';
import { useToast } from '../components/Toasts';
import { Avatar } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { applyTheme, usePrefs } from '../lib/prefs';
import { useMe } from '../lib/session';

export function AccountPage() {
  const me = useMe();
  const toast = useToast();
  const [prefs, setPrefs] = usePrefs();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/password', { body: { currentPassword: current, newPassword: next } });
      setCurrent('');
      setNext('');
      toast('Senha trocada. As outras sessões abertas foram encerradas.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Minha conta</h1>
      </div>
      <div className="cfg-grid">
        <section className="panel stack" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 14 }}>
            <Avatar name={me.name} large />
            <div>
              <h2>{me.name}</h2>
              <p className="sub">{me.email}</p>
            </div>
          </div>
          <p className="note">
            <b>{ROLE_LABELS[me.role]}:</b> {ROLE_DESCRIPTIONS[me.role]}
          </p>
          <h3 className="mt8">Aparência neste aparelho</h3>
          <div className="seg" role="radiogroup" aria-label="Tema">
            {(
              [
                ['auto', 'Automático', <IconMonitor key="a" />],
                ['light', 'Claro', <IconSun key="l" />],
                ['dark', 'Escuro', <IconMoon key="d" />],
              ] as const
            ).map(([v, label, icon]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={prefs.theme === v}
                onClick={() => {
                  setPrefs({ theme: v });
                  applyTheme(v);
                }}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
          <p className="sub small">
            O botão "Chamar no WhatsApp" abre o aplicativo no celular e o WhatsApp (Desktop ou Web) no
            computador.
          </p>
        </section>
        <section className="panel">
          <h2>Trocar senha</h2>
          <form onSubmit={submit} className="stack mt12" style={{ gap: 12 }}>
            <input type="email" autoComplete="username" value={me.email} readOnly hidden />
            <label className="field">
              Senha atual
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </label>
            <label className="field">
              Nova senha <small>pelo menos 8 caracteres</small>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </label>
            {error && <p className="error-text">{error}</p>}
            <div>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={busy || !current || next.length < 8}
              >
                {busy ? 'Salvando…' : 'Trocar senha'}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
