import { Eye, EyeOff, Mic, MessagesSquare, Radio, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api, type CurrentUser } from '../api.ts';
import { FormError, Spinner } from './ui.tsx';

export function LoginPage({ onLogin }: { onLogin: (user: CurrentUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    setError(null);
    try {
      onLogin(await api.login(email, password));
    } catch (e) {
      setError((e as Error).message);
      setPassword('');
      setLoading(false);
    }
  };

  return (
    <main className="login">
      <section className="login-hero" aria-hidden>
        <div className="brand">
          <img src="/logo.svg" alt="" width={40} height={40} />
          Central WhatsApp
        </div>
        <div>
          <h2>Todas as conversas da equipe em um só lugar.</h2>
          <p>Atenda os leads de todos os números sem trocar de celular.</p>
        </div>
        <ul className="features">
          <li>
            <span>
              <MessagesSquare />
            </span>
            Caixa única com todos os números
          </li>
          <li>
            <span>
              <Radio />
            </span>
            Mensagens chegando em tempo real
          </li>
          <li>
            <span>
              <Mic />
            </span>
            Áudio, imagem e documento pelo navegador
          </li>
          <li>
            <span>
              <ShieldCheck />
            </span>
            Resposta sempre pelo mesmo número
          </li>
        </ul>
      </section>

      <div className="login-form-wrap">
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="brand">
            <img src="/logo.svg" alt="" width={40} height={40} />
            Central WhatsApp
          </div>
          <div>
            <h1>Entrar</h1>
            <p>Use o e-mail e a senha que o administrador passou para você.</p>
          </div>
          <label className="field">
            <span className="field-label">E-mail</span>
            <input
              className="input"
              type="email"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="field">
            <span className="field-label">Senha</span>
            <span className="input-wrap">
              <input
                className="input"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Esconder senha' : 'Mostrar senha'}
                title={showPassword ? 'Esconder senha' : 'Mostrar senha'}
              >
                {showPassword ? <EyeOff /> : <Eye />}
              </button>
            </span>
          </label>
          {error && <FormError>{error}</FormError>}
          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading && <Spinner />}
            {loading ? 'Entrando…' : 'Entrar'}
          </button>
          <p className="hint">Esqueceu a senha? Peça para um administrador gerar uma nova.</p>
        </form>
      </div>
    </main>
  );
}
