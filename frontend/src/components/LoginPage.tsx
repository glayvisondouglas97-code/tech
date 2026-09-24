import { useState } from 'react';
import { api, type CurrentUser } from '../api.ts';

export function LoginPage({ onLogin }: { onLogin: (user: CurrentUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="login-page">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1>💬 Central WhatsApp</h1>
        <label>
          E-mail
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Senha
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary-button" disabled={loading}>
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
        <p className="login-help">Esqueceu a senha? Peça para um administrador redefinir.</p>
      </form>
    </main>
  );
}
