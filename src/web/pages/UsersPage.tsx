import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import type { InviteLink, UserAdmin } from '../../shared/api';
import { manageableRoles, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES, type Role } from '../../shared/roles';
import { IconCopy, IconDots, IconPlus, IconSearch, IconSparkle } from '../components/Icons';
import { useToast } from '../components/Toasts';
import { Avatar, Confirm, copyText, Dialog, Empty, Menu } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { fmtN, fmtWhen } from '../lib/format';
import { useMe } from '../lib/session';

/** Senha forte e fácil de ditar: sem letras parecidas (l, I, O, 0). */
function generatePassword(length = 12): string {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += chars[b % chars.length];
  return /\d/.test(out) ? out : `${out.slice(0, -1)}7`;
}

function RoleBadge({ role }: { role: Role }) {
  return <span className={`pill role-${role}`}>{ROLE_LABELS[role]}</span>;
}

function PasswordField({
  id,
  value,
  onChange,
  label = 'Senha',
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} <small>pelo menos 8 caracteres</small>
      </label>
      <div className="pw-row">
        <input
          id={id}
          className="input"
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={200}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" className="btn btn-line" onClick={() => setShow(!show)}>
          {show ? 'Ocultar' : 'Mostrar'}
        </button>
        <button
          type="button"
          className="btn btn-line"
          title="Gerar uma senha forte"
          onClick={() => {
            onChange(generatePassword());
            setShow(true);
          }}
        >
          <IconSparkle /> Gerar
        </button>
      </div>
    </div>
  );
}

/** Dados de acesso para passar à pessoa (a senha não fica salva para ser vista de novo). */
function CredentialsDialog({
  data,
  onClose,
}: {
  data: { name: string; email: string; password: string; created: boolean } | null;
  onClose: () => void;
}) {
  const toast = useToast();
  if (!data) return null;
  const url = window.location.origin;
  const text = `Olá, ${data.name.split(' ')[0]}! Seu acesso ao sistema de leads:\nEndereço: ${url}\nE-mail: ${data.email}\nSenha: ${data.password}\nDepois de entrar, você pode trocar a senha em Minha conta.`;
  return (
    <Dialog open onClose={onClose} title={data.created ? 'Usuário criado' : 'Senha definida'}>
      <p>
        <b>{data.name}</b> já pode entrar com estes dados.
        {!data.created && ' As sessões abertas dela foram encerradas.'}
      </p>
      <dl className="cred">
        <dt>Endereço</dt>
        <dd>{url}</dd>
        <dt>E-mail</dt>
        <dd>{data.email}</dd>
        <dt>Senha</dt>
        <dd className="mono">{data.password}</dd>
      </dl>
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={async () =>
            toast((await copyText(text)) ? 'Dados de acesso copiados.' : 'Não consegui copiar.')
          }
        >
          <IconCopy /> Copiar dados de acesso
        </button>
        <a
          className="btn btn-wa"
          href={`https://wa.me/?text=${encodeURIComponent(text)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Enviar pelo WhatsApp
        </a>
      </div>
      <p className="note">
        Por segurança, a senha não aparece de novo depois que você fechar esta janela. Se perder, defina
        outra.
      </p>
    </Dialog>
  );
}

function InviteDialog({
  link,
  onClose,
}: {
  link: { invite: InviteLink; purpose: string; name: string } | null;
  onClose: () => void;
}) {
  const toast = useToast();
  if (!link) return null;
  const msg = `Olá, ${link.name.split(' ')[0]}! Este é o seu acesso ao sistema de leads. Abra o link e crie sua senha (vale por 7 dias): ${link.invite.url}`;
  return (
    <Dialog
      open
      onClose={onClose}
      title={link.purpose === 'convite' ? 'Convite criado' : 'Novo link de senha'}
    >
      <p>
        Envie este link para <b>{link.name}</b>. Com ele, a pessoa cria a própria senha. O link vale por 7
        dias e só funciona uma vez.
      </p>
      <div className="copy-box">
        <label className="vh" htmlFor="invite-url">
          Link
        </label>
        <input
          id="invite-url"
          className="input"
          readOnly
          value={link.invite.url}
          onFocus={(e) => e.target.select()}
        />
        <button
          type="button"
          className="btn btn-line"
          onClick={async () =>
            toast(
              (await copyText(link.invite.url))
                ? 'Link copiado.'
                : 'Não consegui copiar. Selecione e copie manualmente.',
            )
          }
        >
          <IconCopy /> Copiar
        </button>
      </div>
      <div className="row">
        <a
          className="btn btn-wa"
          href={`https://wa.me/?text=${encodeURIComponent(msg)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Enviar pelo WhatsApp
        </a>
        <span className="sub small">Você escolhe o contato no WhatsApp.</span>
      </div>
    </Dialog>
  );
}

/** Escolha do papel mostrando a hierarquia; os papéis acima do meu aparecem bloqueados. */
function RolePicker({
  value,
  onChange,
  allowed,
}: {
  value: Role;
  onChange: (r: Role) => void;
  allowed: Role[];
}) {
  return (
    <fieldset className="role-pick">
      <legend>Hierarquia (papel)</legend>
      {ROLES.map((r) => {
        const ok = allowed.includes(r);
        return (
          <label key={r} className={`role-opt${value === r ? ' on' : ''}${ok ? '' : ' off'}`}>
            <input
              type="radio"
              name="role"
              value={r}
              checked={value === r}
              disabled={!ok}
              onChange={() => onChange(r)}
            />
            <span>
              <b>{ROLE_LABELS[r]}</b>
              <small>{ok ? ROLE_DESCRIPTIONS[r] : 'Só o dono pode dar este papel.'}</small>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function CreateDialog({
  open,
  roles,
  onClose,
  onCreated,
}: {
  open: boolean;
  roles: Role[];
  onClose: () => void;
  onCreated: (r: { name: string; email: string; password?: string; invite: InviteLink | null }) => void;
}) {
  const qc = useQueryClient();
  const empty = { name: '', email: '', role: 'atendente' as Role, password: '' };
  const [form, setForm] = useState(empty);
  const [mode, setMode] = useState<'senha' | 'convite'>('senha');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { name: form.name, email: form.email, role: form.role };
      const r = await api<{ id: string; invite: InviteLink | null }>('/users', {
        body: mode === 'senha' ? { ...body, password: form.password } : body,
      });
      qc.invalidateQueries();
      onCreated({
        name: form.name,
        email: form.email.trim().toLowerCase(),
        password: mode === 'senha' ? form.password : undefined,
        invite: r.invite,
      });
      setForm(empty);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Novo usuário">
      <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
        <div className="form-grid">
          <label className="field">
            Nome
            <input
              className="input"
              required
              maxLength={80}
              autoComplete="off"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="field">
            E-mail <small>é o login</small>
            <input
              className="input"
              type="email"
              required
              autoComplete="off"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </label>
        </div>
        <RolePicker value={form.role} allowed={roles} onChange={(role) => setForm({ ...form, role })} />
        <div className="field">
          <span>Acesso</span>
          <div className="seg" role="radiogroup" aria-label="Como a pessoa vai entrar">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'senha'}
              onClick={() => setMode('senha')}
            >
              Definir a senha agora
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'convite'}
              onClick={() => setMode('convite')}
            >
              Enviar link de convite
            </button>
          </div>
        </div>
        {mode === 'senha' ? (
          <PasswordField
            id="new-user-pw"
            value={form.password}
            onChange={(password) => setForm({ ...form, password })}
          />
        ) : (
          <p className="note">A pessoa recebe um link (vale 7 dias) e cria a própria senha.</p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="row end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            <IconPlus /> {busy ? 'Criando…' : 'Criar usuário'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function EditDialog({ user, roles, onClose }: { user: UserAdmin; roles: Role[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    name: user.name,
    email: user.email,
    role: user.role,
    dailyPullLimit: user.dailyPullLimit == null ? '' : String(user.dailyPullLimit),
  });
  const [error, setError] = useState('');
  return (
    <Dialog open onClose={onClose} title={`Editar ${user.name}`}>
      <form
        className="stack"
        style={{ gap: 14 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          try {
            await api(`/users/${user.id}`, {
              method: 'PATCH',
              body: {
                name: form.name,
                email: form.email,
                role: form.role,
                dailyPullLimit: form.dailyPullLimit === '' ? null : Number(form.dailyPullLimit),
              },
            });
            toast('Dados atualizados.');
            qc.invalidateQueries();
            onClose();
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <div className="form-grid">
          <label className="field">
            Nome
            <input
              className="input"
              required
              maxLength={80}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="field">
            E-mail
            <input
              className="input"
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </label>
        </div>
        <RolePicker value={form.role} allowed={roles} onChange={(role) => setForm({ ...form, role })} />
        <label className="field">
          Limite de leads por dia <small>vazio = padrão da empresa; 0 = sem limite</small>
          <input
            className="input"
            type="number"
            min={0}
            inputMode="numeric"
            value={form.dailyPullLimit}
            onChange={(e) => setForm({ ...form, dailyPullLimit: e.target.value })}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="row end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary">
            Salvar
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function PasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: UserAdmin;
  onClose: () => void;
  onDone: (password: string) => void;
}) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog open onClose={onClose} title={`Definir senha de ${user.name}`}>
      <form
        className="stack"
        style={{ gap: 14 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api(`/users/${user.id}/password`, { body: { password } });
            qc.invalidateQueries({ queryKey: ['users'] });
            onDone(password);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <PasswordField id="set-pw" label="Nova senha" value={password} onChange={setPassword} />
        <p className="note">
          A pessoa passa a entrar com esta senha. Se estiver logada em algum aparelho, sai na hora.
        </p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="row end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Salvando…' : 'Definir senha'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function UsersPage() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserAdmin[]>('/users') });
  /** Papéis que eu posso cadastrar e gerenciar (o administrador não mexe em donos nem administradores). */
  const myRoles = manageableRoles(me.role);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | null>(null);
  const [status, setStatus] = useState<'ativos' | 'desativados' | 'todos'>('ativos');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserAdmin | null>(null);
  const [pwFor, setPwFor] = useState<UserAdmin | null>(null);
  const [creds, setCreds] = useState<{
    name: string;
    email: string;
    password: string;
    created: boolean;
  } | null>(null);
  const [link, setLink] = useState<{ invite: InviteLink; purpose: string; name: string } | null>(null);
  const [deactivating, setDeactivating] = useState<UserAdmin | null>(null);

  const all = users.data ?? [];
  const counts = useMemo(() => {
    const c: Record<Role, number> = { dono: 0, admin: 0, supervisor: 0, atendente: 0 };
    for (const u of all) if (u.active) c[u.role]++;
    return c;
  }, [all]);
  const term = search.trim().toLowerCase();
  const list = all.filter(
    (u) =>
      (!roleFilter || u.role === roleFilter) &&
      (status === 'todos' || (status === 'ativos' ? u.active : !u.active)) &&
      (!term || u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term)),
  );

  async function newLink(u: UserAdmin) {
    try {
      const invite = await api<InviteLink>(`/users/${u.id}/password-link`, { method: 'POST' });
      setLink({ invite, purpose: u.pendingInvite ? 'convite' : 'redefinir', name: u.name });
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    }
  }

  async function setActive(u: UserAdmin, active: boolean) {
    try {
      const r = await api<{ released: number }>(`/users/${u.id}/active`, { body: { active } });
      toast(
        active
          ? `${u.name} foi reativado(a).`
          : `${u.name} perdeu o acesso${r.released ? `; ${fmtN(r.released)} leads voltaram para a fila livre` : ''}.`,
      );
      qc.invalidateQueries();
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    }
  }

  async function release(u: UserAdmin) {
    try {
      const r = await api<{ released: number }>('/leads/release', { body: { userId: u.id } });
      toast(`${fmtN(r.released)} leads de ${u.name} voltaram para a fila livre.`);
      qc.invalidateQueries();
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Usuários</h1>
          <p className="sub">Crie os acessos da equipe, defina as senhas e o papel de cada pessoa.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          <IconPlus /> Novo usuário
        </button>
      </div>

      <div className="roles" role="group" aria-label="Filtrar por papel">
        {ROLES.map((r, i) => (
          <button
            key={r}
            type="button"
            className={`role-card${roleFilter === r ? ' on' : ''}`}
            aria-pressed={roleFilter === r}
            onClick={() => setRoleFilter(roleFilter === r ? null : r)}
          >
            <span className="role-top">
              <RoleBadge role={r} />
              <span className="sub small">nível {i + 1}</span>
            </span>
            <b>{fmtN(counts[r])}</b>
            <span className="sub small">{ROLE_DESCRIPTIONS[r]}</span>
          </button>
        ))}
      </div>

      <section className="panel">
        <div className="toolbar">
          <div className="search">
            <IconSearch />
            <label className="vh" htmlFor="q-users">
              Buscar usuário
            </label>
            <input
              id="q-users"
              className="input"
              type="search"
              placeholder="Buscar por nome ou e-mail"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="prefs">
            <label className="vh" htmlFor="u-status">
              Situação
            </label>
            <select
              id="u-status"
              className="select"
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value="ativos">Ativos</option>
              <option value="desativados">Desativados</option>
              <option value="todos">Todos</option>
            </select>
          </div>
        </div>

        {list.length === 0 ? (
          <Empty title={all.length ? 'Ninguém neste filtro' : 'Nenhum usuário ainda'}>
            <p>Crie o primeiro acesso da equipe em "Novo usuário".</p>
          </Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl utbl">
              <thead>
                <tr>
                  <th>Usuário</th>
                  <th className="l">Papel</th>
                  <th className="l">Situação</th>
                  <th className="l">Último acesso</th>
                  <th>Pegou hoje</th>
                  <th>Na fila</th>
                  <th>
                    <span className="vh">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((u) => {
                  const canManage = myRoles.includes(u.role);
                  return (
                    <tr key={u.id} className={u.active ? '' : 'off'}>
                      <td className="c-user">
                        <span className="u-cell">
                          <Avatar name={u.name} />
                          <span>
                            <b>
                              {u.name} {u.id === me.id && <span className="sub">(você)</span>}
                            </b>
                            <span className="sub small">{u.email}</span>
                          </span>
                        </span>
                      </td>
                      <td className="l c-role">
                        <RoleBadge role={u.role} />
                      </td>
                      <td className="l c-status">
                        {!u.active ? (
                          <span className="pill t-mute">Desativado</span>
                        ) : u.pendingInvite ? (
                          <span className="pill t-warn">Aguardando senha</span>
                        ) : (
                          <span className="pill t-ok">Ativo</span>
                        )}
                      </td>
                      <td className="l c-meta sub">
                        {u.lastLoginAt ? fmtWhen(u.lastLoginAt) : 'Nunca entrou'}
                      </td>
                      <td className="c-num">
                        {fmtN(u.pulledToday)}
                        {u.dailyPullLimit != null && (
                          <span className="sub small">
                            {' '}
                            / {u.dailyPullLimit ? fmtN(u.dailyPullLimit) : 'livre'}
                          </span>
                        )}
                      </td>
                      <td className="c-num">{fmtN(u.queue)}</td>
                      <td className="c-act">
                        {canManage && (
                          <span className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                            <button
                              type="button"
                              className="btn btn-line btn-sm"
                              onClick={() => setEditing(u)}
                            >
                              Editar
                            </button>
                            <Menu label={`Mais ações para ${u.name}`} icon={<IconDots />}>
                              {u.active && u.id !== me.id && (
                                <button type="button" role="menuitem" onClick={() => setPwFor(u)}>
                                  Definir nova senha
                                </button>
                              )}
                              {u.active && (
                                <button type="button" role="menuitem" onClick={() => newLink(u)}>
                                  {u.pendingInvite
                                    ? 'Gerar novo convite'
                                    : 'Gerar link para a pessoa trocar a senha'}
                                </button>
                              )}
                              {u.queue > 0 && (
                                <button type="button" role="menuitem" onClick={() => release(u)}>
                                  Devolver {fmtN(u.queue)} leads à fila livre
                                </button>
                              )}
                              {u.id !== me.id && (
                                <>
                                  <hr />
                                  {u.active ? (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="danger"
                                      onClick={() => setDeactivating(u)}
                                    >
                                      Desativar acesso
                                    </button>
                                  ) : (
                                    <button type="button" role="menuitem" onClick={() => setActive(u, true)}>
                                      Reativar acesso
                                    </button>
                                  )}
                                </>
                              )}
                            </Menu>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="sub small mt12">
          Hierarquia: o dono gerencia todos; o administrador gerencia supervisores e atendentes. Desativar
          tira o acesso na hora e devolve os leads pendentes da pessoa para a fila livre.
        </p>
      </section>

      <CreateDialog
        open={creating}
        roles={myRoles}
        onClose={() => setCreating(false)}
        onCreated={(r) => {
          setCreating(false);
          if (r.invite) setLink({ invite: r.invite, purpose: 'convite', name: r.name });
          else if (r.password)
            setCreds({ name: r.name, email: r.email, password: r.password, created: true });
        }}
      />
      {editing && (
        <EditDialog key={editing.id} user={editing} roles={myRoles} onClose={() => setEditing(null)} />
      )}
      {pwFor && (
        <PasswordDialog
          key={pwFor.id}
          user={pwFor}
          onClose={() => setPwFor(null)}
          onDone={(password) => {
            setCreds({ name: pwFor.name, email: pwFor.email, password, created: false });
            setPwFor(null);
          }}
        />
      )}
      <CredentialsDialog data={creds} onClose={() => setCreds(null)} />
      <InviteDialog link={link} onClose={() => setLink(null)} />
      <Confirm
        open={!!deactivating}
        title={`Desativar ${deactivating?.name}?`}
        confirmLabel="Desativar"
        danger
        onClose={() => setDeactivating(null)}
        onConfirm={() => {
          if (deactivating) void setActive(deactivating, false);
          setDeactivating(null);
        }}
      >
        <p>
          A pessoa perde o acesso na hora (inclusive se estiver logada).
          {deactivating?.queue
            ? ` Os ${fmtN(deactivating.queue)} leads pendentes dela voltam para a fila livre.`
            : ''}{' '}
          O histórico do que ela fez continua guardado. Dá para reativar depois.
        </p>
      </Confirm>
    </div>
  );
}
