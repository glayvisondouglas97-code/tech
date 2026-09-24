import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type {
  AdminSettings,
  BlockedPhone,
  ListSummary,
  MessageTemplate,
  Page,
  PrivacySearch,
} from '../../shared/api';
import { BASE_VARIABLES, fillTemplate } from '../../shared/template';
import { IconPlus } from '../components/Icons';
import { useToast } from '../components/Toasts';
import { Confirm, Pager } from '../components/ui';
import { api, apiDownload, errorMessage, qs } from '../lib/api';
import { fmtN, fmtWhen, plural } from '../lib/format';
import { useDebounced } from '../lib/hooks';
import { useMe, useSession } from '../lib/session';

const SECTIONS = [
  ['mensagens', 'Mensagens prontas'],
  ['fila', 'Fila e regras'],
  ['empresa', 'Empresa'],
  ['bloqueados', 'Não contatar'],
  ['lgpd', 'Privacidade (LGPD)'],
] as const;
type Section = (typeof SECTIONS)[number][0];

function TemplatesSection() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<MessageTemplate[]>('/templates'),
  });
  const lists = useQuery({ queryKey: ['lists', false], queryFn: () => api<ListSummary[]>('/lists') });
  const [currentId, setCurrentId] = useState<string | 'novo' | null>(null);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [deleting, setDeleting] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const list = templates.data ?? [];
  const current = currentId === 'novo' ? null : (list.find((t) => t.id === currentId) ?? list[0] ?? null);

  useEffect(() => {
    if (currentId === 'novo') return;
    setName(current?.name ?? '');
    setBody(current?.body ?? '');
  }, [current?.name, current?.body, currentId]);

  const extraKeys = [...new Set((lists.data ?? []).flatMap((l) => l.extraColumns))].slice(0, 12);
  const sample = { name: 'Mariana Souza', extra: Object.fromEntries(extraKeys.map((k) => [k, `(${k})`])) };
  const dirty = currentId === 'novo' || name !== (current?.name ?? '') || body !== (current?.body ?? '');

  function insert(v: string) {
    const el = ta.current;
    if (!el) return;
    const s = el.selectionStart ?? body.length;
    const e = el.selectionEnd ?? body.length;
    const next = body.slice(0, s) + v + body.slice(e);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + v.length, s + v.length);
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const r =
        currentId === 'novo' || !current
          ? await api<MessageTemplate[]>('/templates', { body: { name, body } })
          : await api<MessageTemplate[]>(`/templates/${current.id}`, { method: 'PUT', body: { name, body } });
      qc.setQueryData(['templates'], r);
      qc.invalidateQueries({ queryKey: ['app-config'] });
      if (currentId === 'novo') setCurrentId(r.find((t) => t.name === name)?.id ?? null);
      toast('Mensagem salva. Já vale para toda a equipe.');
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    }
  }

  async function makeDefault() {
    if (!current) return;
    const r = await api<MessageTemplate[]>(`/templates/${current.id}/default`, { method: 'POST' });
    qc.setQueryData(['templates'], r);
    qc.invalidateQueries({ queryKey: ['app-config'] });
    toast(`"${current.name}" agora é a mensagem padrão.`);
  }

  async function remove() {
    if (!current) return;
    const r = await api<MessageTemplate[]>(`/templates/${current.id}`, { method: 'DELETE' });
    qc.setQueryData(['templates'], r);
    qc.invalidateQueries({ queryKey: ['app-config'] });
    setCurrentId(null);
    setDeleting(false);
  }

  return (
    <div className="cfg-grid">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Mensagens</h2>
            <p className="sub">O atendente escolhe qual usar. A padrão já vem marcada.</p>
          </div>
          <button
            type="button"
            className="btn btn-line btn-sm"
            onClick={() => {
              setCurrentId('novo');
              setName('');
              setBody('');
            }}
          >
            <IconPlus /> Nova
          </button>
        </div>
        <ul className="tpl-list">
          {list.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                aria-current={current?.id === t.id && currentId !== 'novo'}
                onClick={() => setCurrentId(t.id)}
              >
                <span>{t.name}</span>
                {t.isDefault && <span className="tag info">padrão</span>}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <form onSubmit={save} className="stack" style={{ gap: 12 }}>
          <h2>{currentId === 'novo' ? 'Nova mensagem' : 'Editar mensagem'}</h2>
          <label className="field">
            Nome <small>só a equipe vê</small>
            <input
              className="input"
              required
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Primeiro contato"
            />
          </label>
          <label className="field">
            Texto
            <textarea
              ref={ta}
              className="input"
              rows={6}
              maxLength={2000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <div className="vars">
            Inserir:
            {[...BASE_VARIABLES, ...extraKeys.map((k) => `{${k}}`)].map((v) => (
              <button key={v} type="button" onClick={() => insert(v)}>
                {v}
              </button>
            ))}
          </div>
          <p className="sub small">
            {'{nome}'} = primeiro nome com inicial maiúscula · {'{atendente}'} = nome de quem está chamando ·
            colunas extras da planilha também funcionam.
          </p>
          <p className="eyebrow">Como o cliente vai receber</p>
          <div className="bubble">
            {fillTemplate(body, sample, me.name) || '(sem texto: o WhatsApp abre com a conversa em branco)'}
          </div>
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={!dirty || !name.trim()}>
              Salvar mensagem
            </button>
            {current && currentId !== 'novo' && !current.isDefault && (
              <button type="button" className="btn btn-line" onClick={makeDefault}>
                Usar como padrão
              </button>
            )}
            {current && currentId !== 'novo' && list.length > 1 && (
              <button type="button" className="btn btn-ghost" onClick={() => setDeleting(true)}>
                Excluir
              </button>
            )}
          </div>
        </form>
      </section>
      <Confirm
        open={deleting}
        title="Excluir mensagem?"
        confirmLabel="Excluir"
        danger
        onClose={() => setDeleting(false)}
        onConfirm={remove}
      >
        <p>A mensagem "{current?.name}" deixa de aparecer para a equipe.</p>
      </Confirm>
    </div>
  );
}

function RulesSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api<AdminSettings>('/settings') });
  const [form, setForm] = useState<AdminSettings | null>(null);
  useEffect(() => {
    if (s.data) setForm(s.data);
  }, [s.data]);
  if (!form) return <p className="sub">Carregando…</p>;
  const num = (k: keyof AdminSettings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: Number(e.target.value) || 0 });

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    try {
      const r = await api<AdminSettings>('/settings', { method: 'PUT', body: { ...form } });
      qc.setQueryData(['settings'], r);
      qc.invalidateQueries({ queryKey: ['app-config'] });
      qc.invalidateQueries({ queryKey: ['queue-stats'] });
      toast('Regras salvas.');
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    }
  }
  return (
    <form onSubmit={save} className="panel stack" style={{ gap: 16, maxWidth: 760 }}>
      <h2>Fila e regras</h2>
      <div className="form-grid">
        <label className="field">
          Máximo de leads por pedido <small>o atendente escolhe quantos, até este número</small>
          <input
            className="input"
            type="number"
            min={1}
            max={1000}
            value={form.pullSize}
            onChange={num('pullSize')}
          />
        </label>
        <label className="field">
          Limite de leads por dia, por atendente{' '}
          <small>0 = sem limite; dá para mudar por pessoa na Equipe</small>
          <input
            className="input"
            type="number"
            min={0}
            value={form.dailyPullLimit}
            onChange={num('dailyPullLimit')}
          />
        </label>
        <label className="field">
          Máximo na fila de cada atendente <small>0 = sem limite</small>
          <input className="input" type="number" min={0} value={form.maxQueue} onChange={num('maxQueue')} />
        </label>
        <label className="field">
          Devolver leads parados depois de (horas) <small>0 = nunca</small>
          <input
            className="input"
            type="number"
            min={0}
            max={8760}
            value={form.expireHours}
            onChange={num('expireHours')}
          />
        </label>
        <label className="field">
          Avisar ao abrir mais de X conversas por hora <small>0 = sem aviso</small>
          <input
            className="input"
            type="number"
            min={0}
            value={form.hourlyContactWarning}
            onChange={num('hourlyContactWarning')}
          />
        </label>
        <label className="field">
          DDD padrão das importações <small>opcional</small>
          <input
            className="input"
            inputMode="numeric"
            maxLength={2}
            value={form.defaultDdd ?? ''}
            onChange={(e) => setForm({ ...form, defaultDdd: e.target.value.replace(/\D/g, '') || null })}
          />
        </label>
      </div>
      <p className="note">
        <b>Leads parados:</b> quando o atendente pega leads e não abre nenhum no WhatsApp dentro do prazo,
        eles voltam sozinhos para a fila livre. Leads divididos na importação ou passados pelo gestor não
        voltam sozinhos. O aviso de conversas por hora ajuda a evitar que o número seja bloqueado pelo
        WhatsApp por excesso de mensagens.
      </p>
      <div>
        <button type="submit" className="btn btn-primary">
          Salvar regras
        </button>
      </div>
    </form>
  );
}

function CompanySection() {
  const qc = useQueryClient();
  const toast = useToast();
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api<AdminSettings>('/settings') });
  const [name, setName] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (s.data) setName(s.data.companyName);
  }, [s.data]);
  if (!s.data) return <p className="sub">Carregando…</p>;
  const data = s.data;

  async function saveName(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/settings', { method: 'PUT', body: { ...data, companyName: name } });
      qc.invalidateQueries();
      toast('Nome salvo.');
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file, file.name);
    try {
      await api('/settings/logo', { method: 'PUT', body: fd });
      setVersion((v) => v + 1);
      qc.invalidateQueries();
      toast('Logo atualizado.');
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    }
  }
  return (
    <div className="cfg-grid">
      <form onSubmit={saveName} className="panel stack" style={{ gap: 12 }}>
        <h2>Nome da empresa</h2>
        <p className="sub">Aparece no topo, na tela de entrada e no título da aba.</p>
        <input
          className="input"
          required
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div>
          <button type="submit" className="btn btn-primary">
            Salvar
          </button>
        </div>
      </form>
      <section className="panel stack" style={{ gap: 12 }}>
        <h2>Logo</h2>
        <p className="sub">PNG, JPG ou WebP, quadrado, até 300 KB.</p>
        {data.hasLogo && (
          <img
            src={`/api/branding/logo?v=${version}`}
            alt="Logo atual"
            style={{ width: 64, height: 64, objectFit: 'contain', borderRadius: 10 }}
          />
        )}
        <div className="row">
          <label className="btn btn-line" htmlFor="logo-file">
            Escolher imagem
          </label>
          <input
            className="vh"
            id="logo-file"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => void upload(e.target.files?.[0])}
          />
          {data.hasLogo && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={async () => {
                await api('/settings/logo', { method: 'DELETE' });
                qc.invalidateQueries();
              }}
            >
              Remover logo
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function BlocklistSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [removing, setRemoving] = useState<BlockedPhone | null>(null);
  const dq = useDebounced(q, 300);
  const data = useQuery({
    queryKey: ['blocklist', dq, page],
    queryFn: () => api<Page<BlockedPhone>>(`/blocklist${qs({ q: dq, page })}`),
    placeholderData: keepPreviousData,
  });

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ leads: number }>('/blocklist', { body: { phone, reason: reason || undefined } });
      toast(`Número bloqueado${r.leads ? `; ${plural(r.leads, 'lead saiu', 'leads saíram')} da fila` : ''}.`);
      setPhone('');
      setReason('');
      qc.invalidateQueries();
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    }
  }
  async function remove(b: BlockedPhone) {
    try {
      const r = await api<{ leads: number }>('/blocklist/remove', { body: { phone: b.phone } });
      toast(
        `${b.display} pode ser contatado de novo${r.leads ? `; ${plural(r.leads, 'lead voltou', 'leads voltaram')}` : ''}.`,
      );
      qc.invalidateQueries();
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    }
    setRemoving(null);
  }
  return (
    <div className="stack">
      <form onSubmit={add} className="panel stack" style={{ gap: 12 }}>
        <h2>Não contatar</h2>
        <p className="sub">
          Números desta lista nunca entram na fila, em nenhuma importação. O atendente também pode bloquear
          pelo botão "Não quer contato".
        </p>
        <div className="row">
          <input
            className="input"
            style={{ maxWidth: 220 }}
            placeholder="(41) 99876-5432"
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            aria-label="Telefone"
          />
          <input
            className="input"
            style={{ maxWidth: 320 }}
            placeholder="Motivo (opcional)"
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Motivo"
          />
          <button type="submit" className="btn btn-primary">
            Bloquear número
          </button>
        </div>
      </form>
      <section className="panel">
        <div className="panel-head">
          <h2>
            {data.data
              ? plural(data.data.total, 'número bloqueado', 'números bloqueados')
              : 'Números bloqueados'}
          </h2>
          <input
            className="input"
            style={{ maxWidth: 240 }}
            type="search"
            placeholder="Buscar número"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {!data.data?.items.length ? (
          <p className="sub">Nenhum número na lista.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Telefone</th>
                  <th className="l">Motivo</th>
                  <th className="l">Quando</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.data.items.map((b) => (
                  <tr key={b.phone}>
                    <td className="phone">{b.display}</td>
                    <td className="l">{b.reason}</td>
                    <td className="l sub">
                      {fmtWhen(b.createdAt)}
                      {b.createdBy ? ` · ${b.createdBy.name}` : ''}
                    </td>
                    <td>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRemoving(b)}>
                        Desbloquear
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager
          page={page}
          pageSize={data.data?.pageSize ?? 50}
          total={data.data?.total ?? 0}
          onPage={setPage}
        />
      </section>
      <Confirm
        open={!!removing}
        title="Desbloquear número?"
        confirmLabel="Desbloquear"
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove(removing)}
      >
        <p>
          {removing?.display} poderá ser chamado de novo. Só faça isso se a pessoa pediu ou autorizou. Leads
          com este número que ainda não foram chamados voltam para a fila livre.
        </p>
      </Confirm>
    </div>
  );
}

function PrivacySection() {
  const toast = useToast();
  const qc = useQueryClient();
  const [phone, setPhone] = useState('');
  const [result, setResult] = useState<PrivacySearch | null>(null);
  const [keepBlocked, setKeepBlocked] = useState(true);
  const [action, setAction] = useState<'anonymize' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(e?: FormEvent) {
    e?.preventDefault();
    try {
      setResult(await api<PrivacySearch>('/privacy/search', { body: { phone } }));
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    }
  }
  async function exportData() {
    try {
      await apiDownload('/privacy/export', { phone: result?.phone ?? phone }, 'dados-do-titular.json');
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    }
  }
  async function run() {
    if (!action || !result) return;
    setBusy(true);
    try {
      const r = await api<{ leads: number }>(`/privacy/${action}`, {
        body: { phone: result.phone, block: keepBlocked, confirm: true },
      });
      toast(
        action === 'anonymize'
          ? `${plural(r.leads, 'registro anonimizado', 'registros anonimizados')}.`
          : `${plural(r.leads, 'registro excluído', 'registros excluídos')}.`,
      );
      qc.invalidateQueries();
      await search();
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    } finally {
      setBusy(false);
      setAction(null);
    }
  }

  return (
    <div className="stack">
      <section className="panel stack" style={{ gap: 12 }}>
        <h2>Pedidos de titulares (LGPD)</h2>
        <p className="sub">
          Quando uma pessoa pede para saber quais dados vocês têm dela, para corrigir ou para apagar, procure
          pelo telefone. Cada consulta fica registrada.
        </p>
        <form className="row" onSubmit={search}>
          <input
            className="input"
            style={{ maxWidth: 240 }}
            placeholder="(41) 99876-5432"
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            aria-label="Telefone"
          />
          <button type="submit" className="btn btn-primary">
            Procurar
          </button>
        </form>
      </section>
      {result && (
        <section className="panel stack" style={{ gap: 12 }}>
          <h2>
            {result.display}: {plural(result.leads.length, 'registro', 'registros')}
            {result.blocked && (
              <span className="tag bad" style={{ marginLeft: 8 }}>
                Não contatar
              </span>
            )}
          </h2>
          {result.leads.length > 0 && (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th className="l">Lista</th>
                    <th className="l">Situação</th>
                    <th>Eventos</th>
                  </tr>
                </thead>
                <tbody>
                  {result.leads.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.company || l.name}
                        {l.company && l.name && <div className="sub small">Sócio: {l.name}</div>}
                      </td>
                      <td className="l">{l.listName}</td>
                      <td className="l">{l.calledAt ? `Chamado ${fmtWhen(l.calledAt)}` : l.status}</td>
                      <td>{fmtN(l.events)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={keepBlocked} onChange={(e) => setKeepBlocked(e.target.checked)} />
            Manter o número na lista de não contatar
            <small>Recomendado: garante que a pessoa não seja chamada de novo numa próxima importação.</small>
          </label>
          <div className="row">
            <button type="button" className="btn btn-line" onClick={exportData}>
              Baixar os dados (arquivo)
            </button>
            <button
              type="button"
              className="btn btn-line"
              disabled={!result.leads.length}
              onClick={() => setAction('anonymize')}
            >
              Anonimizar
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={!result.leads.length}
              onClick={() => setAction('delete')}
            >
              Excluir de vez
            </button>
          </div>
          <p className="note">
            <b>Anonimizar</b> apaga nome, telefone, colunas extras e observações, mas mantém os números do
            painel. <b>Excluir</b> apaga os registros e o histórico. As duas ações não podem ser desfeitas.
          </p>
        </section>
      )}
      <Confirm
        open={!!action}
        title={action === 'delete' ? 'Excluir os dados desta pessoa?' : 'Anonimizar os dados desta pessoa?'}
        confirmLabel={action === 'delete' ? 'Excluir de vez' : 'Anonimizar'}
        danger
        busy={busy}
        onClose={() => setAction(null)}
        onConfirm={run}
      >
        <p>
          Afeta {plural(result?.leads.length ?? 0, 'registro', 'registros')} com o telefone {result?.display}.
          Não dá para desfazer.
        </p>
      </Confirm>
    </div>
  );
}

export function SettingsPage() {
  const { can } = useSession();
  const [section, setSection] = useState<Section>(() => {
    const h = window.location.hash.slice(1);
    return (SECTIONS.find(([k]) => k === h)?.[0] ?? 'mensagens') as Section;
  });
  return (
    <div>
      <div className="page-head">
        <h1>Configurações</h1>
      </div>
      <nav className="subtabs" aria-label="Seções de configuração">
        {SECTIONS.filter(([k]) => k !== 'lgpd' || can('privacy')).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`subtab${section === k ? ' active' : ''}`}
            aria-current={section === k ? 'page' : undefined}
            onClick={() => {
              setSection(k);
              history.replaceState(null, '', `#${k}`);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {section === 'mensagens' && <TemplatesSection />}
      {section === 'fila' && <RulesSection />}
      {section === 'empresa' && <CompanySection />}
      {section === 'bloqueados' && <BlocklistSection />}
      {section === 'lgpd' && can('privacy') && <PrivacySection />}
    </div>
  );
}
