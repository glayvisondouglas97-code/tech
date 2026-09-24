import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import type { SessionInfo } from '../../shared/api';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { AuthCard } from './LoginPage';

/** Primeiro acesso: cria o dono (acesso master) usando o código de primeiro acesso (SETUP_TOKEN). */
export function SetupPage() {
  const { me, signedIn } = useSession();
  const navigate = useNavigate();
  const status = useQuery({
    queryKey: ['setup'],
    queryFn: () => api<{ needed: boolean; enabled: boolean }>('/setup'),
  });
  const [form, setForm] = useState({ setupToken: '', name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (me) return <Navigate to="/chamar" replace />;
  if (status.data && !status.data.needed) return <Navigate to="/entrar" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const s = await api<SessionInfo>('/setup', { body: form });
      signedIn(s);
      navigate('/usuarios', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <AuthCard>
      <h1 className="auth-title">Primeiro acesso</h1>
      {status.data && !status.data.enabled ? (
        <p className="sub">
          O sistema ainda não tem dono. Peça para quem instalou rodar o comando{' '}
          <code>npm run criar-admin</code> ou definir o código <code>SETUP_TOKEN</code> na hospedagem (veja o
          README).
        </p>
      ) : (
        <>
          <p className="sub">
            Crie a sua conta de dono, com acesso a tudo. Depois você cadastra a equipe em Usuários. O código
            aparece no terminal (npm run dev) ou na variável SETUP_TOKEN da hospedagem.
          </p>
          <form onSubmit={submit}>
            <label className="field">
              Código de primeiro acesso
              <input
                className="input"
                type="password"
                autoComplete="off"
                required
                value={form.setupToken}
                onChange={set('setupToken')}
              />
            </label>
            <label className="field">
              Seu nome
              <input
                className="input"
                autoComplete="name"
                required
                maxLength={80}
                value={form.name}
                onChange={set('name')}
              />
            </label>
            <label className="field">
              E-mail
              <input
                className="input"
                type="email"
                autoComplete="username"
                required
                value={form.email}
                onChange={set('email')}
              />
            </label>
            <label className="field">
              Senha <small>pelo menos 8 caracteres</small>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={form.password}
                onChange={set('password')}
              />
            </label>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
              {busy ? 'Criando…' : 'Criar conta do dono'}
            </button>
          </form>
        </>
      )}
    </AuthCard>
  );
}
