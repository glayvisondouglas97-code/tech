import { useEffect, useState } from 'react';
import { api, type CurrentUser } from '../api.ts';

type Props = { me: CurrentUser; onBack: () => void };

// Equipe (só administradores): criar acesso, redefinir senha, desativar e dar acesso de administrador.
export function UsersPage({ me, onBack }: Props) {
  const [users, setUsers] = useState<CurrentUser[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ who: string; password: string } | null>(null);

  const load = () => api.users().then(setUsers).catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const act = async (task: () => Promise<unknown>) => {
    setError(null);
    try {
      await task();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const create = () =>
    act(async () => {
      const result = await api.createUser(name, email, isAdmin);
      setNotice({ who: result.user.name, password: result.temporaryPassword });
      setName('');
      setEmail('');
      setIsAdmin(false);
    });

  const resetPassword = (user: CurrentUser) => {
    if (!confirm(`Gerar uma senha provisória nova para ${user.name}? Os logins dessa pessoa serão encerrados.`)) return;
    void act(async () => {
      const result = await api.resetPassword(user.id);
      setNotice({ who: user.name, password: result.temporaryPassword });
    });
  };

  return (
    <main className="numbers-page">
      <header className="numbers-header">
        <button className="link-button" onClick={onBack}>
          ← Conversas
        </button>
        <h1>Usuários</h1>
      </header>

      <form
        className="add-user"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input placeholder="Nome" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
        <input placeholder="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label className="checkbox">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> Administrador
        </label>
        <button type="submit" className="primary-button">
          + Adicionar
        </button>
      </form>

      {notice && (
        <div className="notice" role="status">
          <p>
            Senha provisória de <strong>{notice.who}</strong>: <code>{notice.password}</code>
          </p>
          <p>Anote e passe para a pessoa. Ela não aparece de novo. No primeiro acesso, a pessoa troca em "Minha senha".</p>
          <button className="link-button" onClick={() => setNotice(null)}>
            Entendi
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <ul className="number-list">
        {users.map((user) => {
          const isMe = user.id === me.id;
          return (
            <li key={user.id} className={`number-row ${user.active ? '' : 'inactive'}`}>
              <div className="number-info">
                <div className="number-title">
                  <strong>{user.name}</strong>
                  {user.isAdmin && <span className="tag">administrador</span>}
                  {!user.active && <span className="tag off">desativado</span>}
                  {isMe && <span className="tag">você</span>}
                </div>
                <span className="number-meta">{user.email}</span>
              </div>
              <div className="row-actions">
                {/* A própria senha se troca em "Minha senha" (redefinir aqui desconectaria antes de mostrar a nova). */}
                {!isMe && (
                  <>
                    <button className="link-button" onClick={() => resetPassword(user)}>
                      Redefinir senha
                    </button>
                    <button className="link-button" onClick={() => act(() => api.updateUser(user.id, { isAdmin: !user.isAdmin }))}>
                      {user.isAdmin ? 'Remover admin' : 'Tornar admin'}
                    </button>
                    <button className="link-button danger" onClick={() => act(() => api.updateUser(user.id, { active: !user.active }))}>
                      {user.active ? 'Desativar' : 'Reativar'}
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
