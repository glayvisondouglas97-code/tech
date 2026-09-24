import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { SessionInfo } from '../../shared/api';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { AuthCard } from './LoginPage';

/** Página do link de convite / redefinição. O token vem depois do "#" e nunca vai para o servidor na URL. */
export function SetPasswordPage() {
  const token = useMemo(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '', []);
  const { signedIn } = useSession();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const info = useQuery({
    queryKey: ['token-info', token],
    queryFn: () =>
      api<{ purpose: 'convite' | 'redefinir'; name: string; email: string }>('/auth/token/info', {
        body: { token },
      }),
    enabled: token.length > 10,
    retry: false,
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError('As duas senhas não são iguais.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const s = await api<SessionInfo>('/auth/token/use', { body: { token, password } });
      history.replaceState(null, '', '/definir-senha');
      signedIn(s);
      navigate('/chamar', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!token || info.isError) {
    return (
      <AuthCard>
        <h1 className="auth-title">Link inválido</h1>
        <p className="sub">Este link expirou ou já foi usado. Peça ao gestor um novo link de acesso.</p>
        <a className="btn btn-line" href="/entrar">
          Ir para a tela de entrada
        </a>
      </AuthCard>
    );
  }
  if (!info.data) {
    return (
      <AuthCard>
        <p className="sub">Conferindo o link…</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard>
      <h1 className="auth-title">
        {info.data.purpose === 'convite' ? `Bem-vindo(a), ${info.data.name.split(' ')[0]}!` : 'Nova senha'}
      </h1>
      <p className="sub">
        Crie a senha para entrar com <b>{info.data.email}</b>. Use pelo menos 8 caracteres.
      </p>
      <form onSubmit={submit}>
        <input type="email" autoComplete="username" value={info.data.email} readOnly hidden />
        <label className="field">
          Senha
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="field">
          Repita a senha
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy || password.length < 8}>
          {busy ? 'Salvando…' : 'Salvar senha e entrar'}
        </button>
      </form>
    </AuthCard>
  );
}
