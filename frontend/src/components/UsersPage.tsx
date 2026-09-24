import { Copy, Ellipsis, KeyRound, ShieldCheck, ShieldOff, UserCheck, UserPlus, UserX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type CurrentUser } from '../api.ts';
import { Avatar, FormError, Menu, Modal, Spinner, toast, type MenuItem } from './ui.tsx';

type Credentials = { name: string; password: string; isNew: boolean };

// Equipe (só administradores): convidar, redefinir senha, desativar e dar acesso de administrador.
export function UsersPage({ me }: { me: CurrentUser }) {
  const [users, setUsers] = useState<CurrentUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [resetting, setResetting] = useState<CurrentUser | null>(null);
  const [credentials, setCredentials] = useState<Credentials | null>(null);

  const load = () =>
    api.users().then(
      (list) => {
        setUsers(list);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    void load();
  }, []);

  const update = async (user: CurrentUser, changes: { active?: boolean; isAdmin?: boolean }, done: string) => {
    try {
      await api.updateUser(user.id, changes);
      await load();
      toast(done);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const itemsFor = (user: CurrentUser): MenuItem[] => [
    { label: 'Gerar nova senha', icon: KeyRound, onSelect: () => setResetting(user) },
    user.isAdmin
      ? {
          label: 'Remover administrador',
          icon: ShieldOff,
          onSelect: () => void update(user, { isAdmin: false }, `${user.name} não é mais administrador`),
        }
      : {
          label: 'Tornar administrador',
          icon: ShieldCheck,
          onSelect: () => void update(user, { isAdmin: true }, `${user.name} agora é administrador`),
        },
    user.active
      ? {
          label: 'Desativar acesso',
          icon: UserX,
          danger: true,
          onSelect: () => void update(user, { active: false }, `Acesso de ${user.name} desativado`),
        }
      : { label: 'Reativar acesso', icon: UserCheck, onSelect: () => void update(user, { active: true }, `Acesso de ${user.name} reativado`) },
  ];

  return (
    <main className="page">
      <div className="page-inner">
        <header className="page-header">
          <div>
            <h1>Usuários</h1>
            <p>Quem da equipe pode entrar na central.</p>
          </div>
          <button className="btn btn-primary" onClick={() => setInviting(true)}>
            <UserPlus aria-hidden /> Adicionar pessoa
          </button>
        </header>

        {error && <FormError>{error}</FormError>}

        <div className="table" role="table" aria-label="Usuários">
          <div className="table-row table-head" role="row">
            <span role="columnheader">Pessoa</span>
            <span role="columnheader">Acesso</span>
            <span role="columnheader">Situação</span>
            <span role="columnheader" className="sr-only">
              Ações
            </span>
          </div>
          {!users && (
            <div className="table-row" role="row">
              <Spinner />
            </div>
          )}
          {users?.map((user) => {
            const isMe = user.id === me.id;
            return (
              <div key={user.id} className={`table-row ${user.active ? '' : 'inactive'}`} role="row">
                <div className="person" role="cell">
                  <Avatar name={user.name} seed={user.email} size="sm" />
                  <div>
                    <strong>
                      {user.name}
                      {isMe && <span className="you">você</span>}
                    </strong>
                    <span>{user.email}</span>
                  </div>
                </div>
                <div className="row-tags">
                  <div className="cell-role" role="cell">
                    <span className="badge plain">{user.isAdmin ? 'Administrador' : 'Atendente'}</span>
                  </div>
                  <div className="cell-status" role="cell">
                    <span className={`badge ${user.active ? 'ok' : 'off'}`}>{user.active ? 'Ativo' : 'Desativado'}</span>
                  </div>
                </div>
                <div className="row-menu" role="cell">
                  {/* A própria senha se troca em "Minha senha" (redefinir aqui desconectaria antes de mostrar a nova). */}
                  {!isMe && (
                    <Menu
                      label={`Ações para ${user.name}`}
                      buttonClassName="icon-btn"
                      button={<Ellipsis />}
                      placement="down-left"
                      items={itemsFor(user)}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {inviting && (
        <InviteModal
          onClose={() => setInviting(false)}
          onCreated={(name, password) => {
            setInviting(false);
            setCredentials({ name, password, isNew: true });
            void load();
          }}
        />
      )}
      {resetting && (
        <ResetModal
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={(password) => {
            setCredentials({ name: resetting.name, password, isNew: false });
            setResetting(null);
          }}
        />
      )}
      {credentials && <CredentialsModal credentials={credentials} onClose={() => setCredentials(null)} />}
    </main>
  );
}

function InviteModal({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string, password: string) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.createUser(name.trim(), email.trim(), isAdmin);
      onCreated(result.user.name, result.temporaryPassword);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal title="Adicionar pessoa" description="A central gera uma senha provisória para o primeiro acesso." onClose={onClose}>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="field">
          <span className="field-label">Nome</span>
          <input className="input" value={name} maxLength={80} autoFocus required onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">E-mail</span>
          <input
            className="input"
            type="email"
            autoComplete="off"
            value={email}
            required
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="switch">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          <span>
            Administrador
            <small className="hint"> — pode adicionar e gerenciar usuários</small>
          </span>
        </label>
        {error && <FormError>{error}</FormError>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? <Spinner /> : <UserPlus aria-hidden />} Adicionar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResetModal({ user, onClose, onDone }: { user: CurrentUser; onClose: () => void; onDone: (password: string) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = async () => {
    setSaving(true);
    setError(null);
    try {
      onDone((await api.resetPassword(user.id)).temporaryPassword);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Gerar nova senha?"
      description={`${user.name} recebe uma senha provisória nova e é desconectado de todos os aparelhos.`}
      onClose={onClose}
    >
      <div className="modal-body">
        {error && <FormError>{error}</FormError>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void reset()} disabled={saving}>
            {saving ? <Spinner /> : <KeyRound aria-hidden />} Gerar senha
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CredentialsModal({ credentials, onClose }: { credentials: Credentials; onClose: () => void }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(credentials.password);
      toast('Senha copiada');
    } catch {
      toast('Não foi possível copiar. Selecione a senha e copie manualmente.', 'error');
    }
  };

  return (
    <Modal
      title={credentials.isNew ? 'Pessoa adicionada' : 'Senha nova gerada'}
      description={`Senha provisória de ${credentials.name}:`}
      onClose={onClose}
    >
      <div className="modal-body">
        <div className="secret-box">
          <code>{credentials.password}</code>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy()}>
            <Copy aria-hidden /> Copiar
          </button>
        </div>
        <p className="hint">
          Passe esta senha para a pessoa. Ela não aparece de novo. No primeiro acesso, a pessoa troca em “Minha senha”.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
            Pronto
          </button>
        </div>
      </div>
    </Modal>
  );
}
