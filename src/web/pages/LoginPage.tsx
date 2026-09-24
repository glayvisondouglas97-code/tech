import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import type { SessionInfo } from '../../shared/api';
import { IconCheck, Logo } from '../components/Icons';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';

export function AuthCard({ children }: { children: React.ReactNode }) {
  const branding = useQuery({
    queryKey: ['branding'],
    queryFn: () => api<{ companyName: string; logoUrl: string | null }>('/branding'),
    staleTime: 300_000,
  });
  const name = branding.data?.companyName ?? 'Chamador de Leads';
  const brand = (
    <div className="brand">
      {branding.data?.logoUrl ? <img src={branding.data.logoUrl} alt="" /> : <Logo />}
      <span>{name}</span>
    </div>
  );
  return (
    <div className="auth">
      <aside className="auth-aside">
        {brand}
        <div className="auth-pitch">
          <h2>Sua equipe chamando empresas pelo WhatsApp, sem planilha e sem contato repetido.</h2>
          <ul>
            <li>
              <IconCheck /> Cada atendente com a própria fila: ninguém chama o mesmo lead.
            </li>
            <li>
              <IconCheck /> Mensagem pronta com o nome da empresa e do sócio.
            </li>
            <li>
              <IconCheck /> Painel e auditoria de tudo o que a equipe faz.
            </li>
          </ul>
        </div>
        <p className="auth-foot">
          © {new Date().getFullYear()} {name}
        </p>
      </aside>
      <div className="auth-wrap">
        <div className="auth-card">
          {brand}
          {children}
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { me, signedIn } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (me) return <Navigate to="/chamar" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const s = await api<SessionInfo>('/auth/login', { body: { email, password } });
      signedIn(s);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/entrar' ? from : '/chamar', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard>
      <div>
        <h1 className="auth-title">Entrar</h1>
        <p className="sub">Use o e-mail e a senha que você cadastrou.</p>
      </div>
      <form onSubmit={submit} noValidate>
        <label className="field">
          E-mail
          <input
            className="input"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          Senha
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !email || !password}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
      <p className="sub" style={{ textAlign: 'center' }}>
        Esqueceu a senha? Peça ao gestor um novo link de acesso.
      </p>
    </AuthCard>
  );
}
