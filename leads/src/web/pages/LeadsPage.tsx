import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { LeadItem, Page } from '../../shared/api';
import { RESULTS } from '../../shared/results';
import { IconDown, IconSearch } from '../components/Icons';
import { LeadDrawer } from '../components/LeadDrawer';
import { useToast } from '../components/Toasts';
import { Dialog, Empty, Pager, ResultPill, Skeleton } from '../components/ui';
import { api, errorMessage, qs } from '../lib/api';
import { fmtN, fmtWhen, plural } from '../lib/format';
import { useDebounced } from '../lib/hooks';
import { leadLabel, leadPartner } from '../lib/leads';
import { type Filters, useLists, useTeam } from './CalledPage';

function situation(l: LeadItem) {
  if (l.status === 'bloqueado') return <span className="tag bad">Não contatar</span>;
  if (l.calledAt) return <ResultPill result={l.result} />;
  return l.assignedTo ? (
    <span className="tag info">Com {l.assignedTo.name}</span>
  ) : (
    <span className="tag">Livre</span>
  );
}

function RedistributeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const team = useTeam(open);
  const lists = useLists(open);
  const qc = useQueryClient();
  const toast = useToast();
  const [from, setFrom] = useState('livre');
  const [to, setTo] = useState<string[]>([]);
  const [quantity, setQuantity] = useState('');
  const [listId, setListId] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const r = await api<{ moved: number; perUser: { name: string; count: number }[] }>(
        '/leads/redistribute',
        {
          body: { from, to, quantity: quantity ? Number(quantity) : undefined, listId: listId || undefined },
        },
      );
      toast(
        r.moved
          ? `${plural(r.moved, 'lead redistribuído', 'leads redistribuídos')}: ${r.perUser.map((p) => `${p.name} ${p.count}`).join(', ')}.`
          : 'Não havia leads para redistribuir.',
      );
      qc.invalidateQueries();
      onClose();
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Redistribuir leads">
      <p className="sub">
        Reparte em partes iguais os leads ainda não chamados. Os leads já chamados não mudam.
      </p>
      <div className="form-grid">
        <label className="field">
          Tirar de
          <select className="select input" value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="livre">Fila livre</option>
            {team.data?.map((u) => (
              <option key={u.id} value={u.id}>
                Fila de {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Da lista
          <select className="select input" value={listId} onChange={(e) => setListId(e.target.value)}>
            <option value="">Todas as listas</option>
            {lists.data?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Quantos <small>vazio = todos</small>
          <input
            className="input"
            type="number"
            min={1}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
      </div>
      <fieldset className="dist" style={{ margin: 0 }}>
        <legend>Passar para</legend>
        <div className="row" style={{ gap: '8px 16px' }}>
          {team.data
            ?.filter((u) => u.id !== from)
            .map((u) => (
              <label key={u.id} className="check" style={{ alignItems: 'center' }}>
                <input
                  type="checkbox"
                  style={{ margin: 0 }}
                  checked={to.includes(u.id)}
                  onChange={(e) => setTo(e.target.checked ? [...to, u.id] : to.filter((x) => x !== u.id))}
                />
                {u.name}
              </label>
            ))}
        </div>
      </fieldset>
      <div className="row end">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="btn btn-primary" disabled={!to.length || busy} onClick={submit}>
          {busy ? 'Redistribuindo…' : 'Redistribuir'}
        </button>
      </div>
    </Dialog>
  );
}

function ReleaseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const team = useTeam(open);
  const qc = useQueryClient();
  const toast = useToast();
  const [userId, setUserId] = useState('');
  const [hours, setHours] = useState('24');
  const [onlyNotOpened, setOnlyNotOpened] = useState(true);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const r = await api<{ released: number }>('/leads/release', {
        body: {
          userId: userId || undefined,
          olderThanHours: hours ? Number(hours) : undefined,
          onlyNotOpened,
        },
      });
      toast(`${plural(r.released, 'lead voltou', 'leads voltaram')} para a fila livre.`);
      qc.invalidateQueries();
      onClose();
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Devolver leads parados">
      <p className="sub">
        Leads ainda não chamados que estão na fila de atendentes voltam para a fila livre.
      </p>
      <div className="form-grid">
        <label className="field">
          De quem
          <select className="select input" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Todos os atendentes</option>
            {team.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Parados há mais de (horas) <small>vazio = todos</small>
          <input
            className="input"
            type="number"
            min={0}
            inputMode="numeric"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={onlyNotOpened} onChange={(e) => setOnlyNotOpened(e.target.checked)} />
        Só os que o atendente nem abriu no WhatsApp
        <small>Evita que outra pessoa mande mensagem para quem já recebeu.</small>
      </label>
      <div className="row end">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
          {busy ? 'Devolvendo…' : 'Devolver à fila livre'}
        </button>
      </div>
    </Dialog>
  );
}

export function LeadsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const team = useTeam(true);
  const lists = useLists(true);
  const [f, setF] = useState<Filters>({
    q: '',
    attendant: '',
    result: '',
    period: 'tudo',
    from: '',
    to: '',
    list: '',
    status: '',
  });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [assignTo, setAssignTo] = useState('');
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [redistributing, setRedistributing] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const q = useDebounced(f.q.trim(), 300);
  const set = (p: Partial<Filters>) => {
    setF((x) => ({ ...x, ...p }));
    setPage(1);
    setSelected(new Set());
  };
  const params = {
    view: 'todos',
    q,
    attendant: f.attendant,
    result: f.result,
    status: f.status,
    period: f.period,
    from: f.period === 'personalizado' ? f.from : '',
    to: f.period === 'personalizado' ? f.to : '',
    list: f.list,
  };
  const data = useQuery({
    queryKey: ['leads', params, page],
    queryFn: () => api<Page<LeadItem>>(`/leads${qs({ ...params, page })}`),
    placeholderData: keepPreviousData,
  });
  const items = data.data?.items ?? [];
  const selectable = items.filter((l) => l.status === 'pendente');
  const allSelected = selectable.length > 0 && selectable.every((l) => selected.has(l.id));

  async function bulk(action: 'atribuir' | 'devolver') {
    try {
      const r = await api<{ moved: number; skipped: number }>('/leads/bulk', {
        body: { ids: [...selected], action, userId: action === 'atribuir' ? assignTo : undefined },
      });
      toast(
        `${plural(r.moved, 'lead movido', 'leads movidos')}${r.skipped ? ` (${fmtN(r.skipped)} já estavam lá ou foram chamados)` : ''}.`,
      );
      setSelected(new Set());
      qc.invalidateQueries();
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <p className="sub">{data.data ? `${fmtN(data.data.total)} leads neste filtro` : ' '}</p>
        </div>
        <div className="row">
          <button type="button" className="btn btn-line btn-sm" onClick={() => setRedistributing(true)}>
            Redistribuir
          </button>
          <button type="button" className="btn btn-line btn-sm" onClick={() => setReleasing(true)}>
            Devolver parados
          </button>
          <a className="btn btn-line btn-sm" href={`/api/export/leads.csv${qs(params)}`} download>
            <IconDown /> CSV
          </a>
          <a className="btn btn-line btn-sm" href={`/api/export/leads.xlsx${qs(params)}`} download>
            <IconDown /> Excel
          </a>
        </div>
      </div>
      <div className="filters">
        <div className="search">
          <IconSearch />
          <label className="vh" htmlFor="q-leads">
            Buscar
          </label>
          <input
            id="q-leads"
            className="input"
            type="search"
            placeholder="Buscar empresa, sócio, telefone ou lista"
            value={f.q}
            onChange={(e) => set({ q: e.target.value })}
          />
        </div>
        <select
          className="select input"
          aria-label="Situação"
          value={f.status}
          onChange={(e) => set({ status: e.target.value })}
        >
          <option value="">Todas as situações</option>
          <option value="pendente">Não chamados</option>
          <option value="livre">Na fila livre</option>
          <option value="com_atendente">Com atendentes</option>
          <option value="chamado">Chamados</option>
          <option value="retorno">Com retorno agendado</option>
          <option value="bloqueado">Não contatar</option>
        </select>
        <select
          className="select input"
          aria-label="Atendente"
          value={f.attendant}
          onChange={(e) => set({ attendant: e.target.value })}
        >
          <option value="">Todos os atendentes</option>
          <option value="livre">Ninguém (fila livre)</option>
          {team.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <select
          className="select input"
          aria-label="Lista"
          value={f.list}
          onChange={(e) => set({ list: e.target.value })}
        >
          <option value="">Todas as listas</option>
          {lists.data?.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <select
          className="select input"
          aria-label="Resultado"
          value={f.result}
          onChange={(e) => set({ result: e.target.value })}
        >
          <option value="">Todos os resultados</option>
          {RESULTS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {selected.size > 0 && (
        <div className="banner info row" style={{ marginBottom: 12 }}>
          <b className="grow">{plural(selected.size, 'lead selecionado', 'leads selecionados')}</b>
          <select
            className="select input"
            style={{ width: 'auto' }}
            aria-label="Passar para"
            value={assignTo}
            onChange={(e) => setAssignTo(e.target.value)}
          >
            <option value="">Passar para…</option>
            {team.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!assignTo}
            onClick={() => bulk('atribuir')}
          >
            Passar
          </button>
          <button type="button" className="btn btn-line btn-sm" onClick={() => bulk('devolver')}>
            Devolver à fila livre
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
            Limpar
          </button>
        </div>
      )}

      {data.isLoading ? (
        <Skeleton rows={6} />
      ) : !items.length ? (
        <section className="panel">
          <Empty title="Nenhum lead neste filtro">
            <p>Importe uma lista em "Listas" ou mude os filtros.</p>
          </Empty>
        </section>
      ) : (
        <section className="panel" style={{ padding: '8px 12px' }}>
          <div className="tbl-wrap">
            <table className="tbl" style={{ opacity: data.isPlaceholderData ? 0.6 : 1 }}>
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      aria-label="Selecionar todos os não chamados desta página"
                      checked={allSelected}
                      disabled={!selectable.length}
                      onChange={(e) =>
                        setSelected(e.target.checked ? new Set(selectable.map((l) => l.id)) : new Set())
                      }
                    />
                  </th>
                  <th className="l">Empresa</th>
                  <th className="l">Sócio</th>
                  <th className="l">Telefone</th>
                  <th className="l">Lista</th>
                  <th className="l">Situação</th>
                  <th className="l">Chamado por</th>
                </tr>
              </thead>
              <tbody>
                {items.map((l) => (
                  <tr key={l.id} className="clickable" onClick={() => setDrawerId(l.id)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Selecionar ${leadLabel(l)}`}
                        disabled={l.status !== 'pendente'}
                        checked={selected.has(l.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(l.id);
                          else next.delete(l.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td className="l">{leadLabel(l)}</td>
                    <td className="l sub">{leadPartner(l) ?? ''}</td>
                    <td className="l phone">{l.phoneDisplay}</td>
                    <td className="l">{l.list.name}</td>
                    <td className="l">{situation(l)}</td>
                    <td className="l sub">
                      {l.calledBy ? `${l.calledBy.name}, ${fmtWhen(l.calledAt)}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <Pager
        page={page}
        pageSize={data.data?.pageSize ?? 50}
        total={data.data?.total ?? 0}
        onPage={(p) => {
          setPage(p);
          setSelected(new Set());
        }}
      />
      <LeadDrawer leadId={drawerId} onClose={() => setDrawerId(null)} />
      <RedistributeDialog open={redistributing} onClose={() => setRedistributing(false)} />
      <ReleaseDialog open={releasing} onClose={() => setReleasing(false)} />
    </>
  );
}
