import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { LeadItem, ListSummary, Page, TeamMember } from '../../shared/api';
import { RESULTS } from '../../shared/results';
import { CallDialog } from '../components/CallDialog';
import {
  IconChat,
  IconClock,
  IconDown,
  IconHistory,
  IconNote,
  IconSearch,
  IconUndo,
} from '../components/Icons';
import { LeadDrawer } from '../components/LeadDrawer';
import { Avatar, Empty, Pager, ResultPill, ResultSelect, Skeleton } from '../components/ui';
import { WhatsAppLink } from '../components/WhatsAppLink';
import { api, qs } from '../lib/api';
import { fmtN, fmtWhen } from '../lib/format';
import { useDebounced } from '../lib/hooks';
import { leadLabel, leadPartner, useLeadActions } from '../lib/leads';
import { useMe, useSession } from '../lib/session';

export interface Filters {
  q: string;
  attendant: string;
  result: string;
  period: string;
  from: string;
  to: string;
  list: string;
  status?: string;
}

export function useTeam(enabled: boolean) {
  return useQuery({
    queryKey: ['team'],
    queryFn: () => api<TeamMember[]>('/team'),
    enabled,
    staleTime: 60_000,
  });
}
export function useLists(enabled: boolean) {
  return useQuery({
    queryKey: ['lists', false],
    queryFn: () => api<ListSummary[]>('/lists'),
    enabled,
    staleTime: 60_000,
  });
}

export function PeriodFields({ f, set }: { f: Filters; set: (p: Partial<Filters>) => void }) {
  return (
    <>
      <select
        className="select input"
        aria-label="Período"
        value={f.period}
        onChange={(e) => set({ period: e.target.value })}
      >
        <option value="hoje">Hoje</option>
        <option value="7d">Últimos 7 dias</option>
        <option value="30d">Últimos 30 dias</option>
        <option value="tudo">Todo o período</option>
        <option value="personalizado">Escolher datas…</option>
      </select>
      {f.period === 'personalizado' && (
        <div className="row" style={{ gridColumn: '1 / -1' }}>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center' }}>
            De
            <input
              type="date"
              className="input"
              value={f.from}
              onChange={(e) => set({ from: e.target.value })}
            />
          </label>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center' }}>
            até
            <input type="date" className="input" value={f.to} onChange={(e) => set({ to: e.target.value })} />
          </label>
        </div>
      )}
    </>
  );
}

function CalledRow({
  lead,
  onHistory,
  onEdit,
}: {
  lead: LeadItem;
  onHistory: () => void;
  onEdit: () => void;
}) {
  const me = useMe();
  const { can } = useSession();
  const actions = useLeadActions();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(lead.note ?? '');
  const editable = !lead.anonymized && (can('manageLeads') || lead.calledBy?.id === me.id);
  const blocked = lead.status === 'bloqueado';

  return (
    <li className="crow">
      <div style={{ minWidth: 0 }}>
        <div className="lead-name">
          <button type="button" onClick={onHistory}>
            {leadLabel(lead)}
          </button>
        </div>
        {leadPartner(lead) && <div className="lead-socio">Sócio: {leadPartner(lead)}</div>}
        <div className="lead-meta">
          <span className="phone">{lead.phoneDisplay}</span>
          <span className="tag">{lead.list.name}</span>
          {blocked && <span className="tag bad">Não contatar</span>}
          {lead.callbackAt && <span className="tag info">Retorno {fmtWhen(lead.callbackAt)}</span>}
          {Object.entries(lead.extra)
            .slice(0, 2)
            .map(([k, v]) => (
              <span key={k} className="x">
                <b>{k}:</b> {v}
              </span>
            ))}
        </div>
        {lead.note && !editing && <div className="note-text">{lead.note}</div>}
      </div>
      <div className="who">
        <Avatar name={lead.calledBy?.name} />
        <div style={{ minWidth: 0 }}>
          <div className="nm">{lead.calledBy?.name ?? '—'}</div>
          <div className="when">{fmtWhen(lead.calledAt)}</div>
        </div>
      </div>
      <div className="res">
        {editable ? (
          <ResultSelect
            value={lead.result ?? 'enviado'}
            onChange={(v) => void actions.update(lead, { result: v })}
          />
        ) : (
          <ResultPill result={lead.result} />
        )}
      </div>
      <div className="crow-act">
        {!lead.anonymized && !blocked && (
          <WhatsAppLink
            lead={lead}
            templateId="none"
            className="icon-btn wa"
            title="Abrir conversa no WhatsApp"
          >
            <IconChat />
          </WhatsAppLink>
        )}
        {editable && (
          <button
            type="button"
            className="icon-btn"
            title={lead.note ? 'Editar observação' : 'Adicionar observação'}
            aria-label="Observação"
            onClick={() => setEditing(true)}
          >
            <IconNote />
          </button>
        )}
        {editable && !blocked && (
          <button
            type="button"
            className="icon-btn"
            title="Agendar retorno ou atualizar o contato"
            aria-label="Agendar retorno ou atualizar o contato"
            onClick={onEdit}
          >
            <IconClock />
          </button>
        )}
        {editable &&
          !blocked &&
          (() => {
            const mine = lead.calledBy?.id === me.id;
            const label = mine
              ? 'Chamar de novo (volta para a sua fila)'
              : 'Devolver à fila livre para chamar de novo';
            return (
              <button
                type="button"
                className="icon-btn"
                title={label}
                aria-label={label}
                onClick={() => actions.requeue(lead, mine ? 'minha' : 'livre')}
              >
                <IconUndo />
              </button>
            );
          })()}
        <button
          type="button"
          className="icon-btn"
          title="Histórico"
          aria-label="Histórico"
          onClick={onHistory}
        >
          <IconHistory />
        </button>
      </div>
      {editing && (
        <div className="note-edit">
          <label className="vh" htmlFor={`note-${lead.id}`}>
            Observação
          </label>
          <textarea
            id={`note-${lead.id}`}
            className="input"
            rows={2}
            maxLength={1000}
            autoFocus
            placeholder="Ex.: pediu para retornar sexta de manhã"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="row end">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setEditing(false);
                setNote(lead.note ?? '');
              }}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={async () => {
                const ok = await actions.update(lead, { note: note.trim() || null }, 'Observação salva.');
                if (ok) setEditing(false);
              }}
            >
              Salvar observação
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function CalledPage() {
  const { can } = useSession();
  const manager = can('seeAllLeads');
  const [f, setF] = useState<Filters>({
    q: '',
    attendant: '',
    result: '',
    period: '7d',
    from: '',
    to: '',
    list: '',
  });
  const [page, setPage] = useState(1);
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [editLead, setEditLead] = useState<LeadItem | null>(null);
  const q = useDebounced(f.q.trim(), 300);
  const team = useTeam(manager);
  const lists = useLists(manager);
  const set = (p: Partial<Filters>) => {
    setF((x) => ({ ...x, ...p }));
    setPage(1);
  };
  const params = {
    view: 'chamados',
    q,
    attendant: f.attendant,
    result: f.result,
    period: f.period,
    from: f.period === 'personalizado' ? f.from : '',
    to: f.period === 'personalizado' ? f.to : '',
    list: f.list,
  };
  const data = useQuery({
    queryKey: ['leads', params, page],
    queryFn: () => api<Page<LeadItem>>(`/leads${qs({ ...params, page })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const total = data.data?.total ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Já chamados</h1>
          <p className="sub">
            {data.data ? `${fmtN(total)} ${total === 1 ? 'lead' : 'leads'} neste filtro` : ' '}
            {!manager && ' · você vê só os que você chamou'}
          </p>
        </div>
        {can('exportData') && total > 0 && (
          <div className="row">
            <a className="btn btn-line btn-sm" href={`/api/export/leads.csv${qs(params)}`} download>
              <IconDown />
              Baixar CSV
            </a>
            <a className="btn btn-line btn-sm" href={`/api/export/leads.xlsx${qs(params)}`} download>
              <IconDown />
              Baixar Excel
            </a>
          </div>
        )}
      </div>
      <div className={`filters${manager ? '' : ' three'}`}>
        <div className="search">
          <IconSearch />
          <label className="vh" htmlFor="q-called">
            Buscar
          </label>
          <input
            id="q-called"
            className="input"
            type="search"
            placeholder="Buscar empresa, sócio, telefone ou lista"
            autoComplete="off"
            value={f.q}
            onChange={(e) => set({ q: e.target.value })}
          />
        </div>
        {manager && (
          <select
            className="select input"
            aria-label="Atendente"
            value={f.attendant}
            onChange={(e) => set({ attendant: e.target.value })}
          >
            <option value="">Todos os atendentes</option>
            <option value="me">Só os meus</option>
            {team.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        )}
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
        {manager && (
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
        )}
        <PeriodFields f={f} set={set} />
      </div>
      {data.isLoading ? (
        <Skeleton rows={6} />
      ) : !data.data?.items.length ? (
        <ul className="leads">
          <li style={{ listStyle: 'none' }}>
            <Empty title="Nada neste filtro">
              <p>
                Tente mudar o período ou os filtros. Quando alguém marcar um lead como chamado, ele aparece
                aqui com o nome de quem chamou.
              </p>
            </Empty>
          </li>
        </ul>
      ) : (
        <ul className="leads" style={{ opacity: data.isPlaceholderData ? 0.6 : 1 }}>
          {data.data.items.map((l) => (
            <CalledRow
              key={`${l.id}-${l.version}`}
              lead={l}
              onHistory={() => setDrawerId(l.id)}
              onEdit={() => setEditLead(l)}
            />
          ))}
        </ul>
      )}
      <Pager
        page={page}
        pageSize={data.data?.pageSize ?? 50}
        total={total}
        onPage={(p) => {
          setPage(p);
          window.scrollTo(0, 0);
        }}
      />
      <LeadDrawer leadId={drawerId} onClose={() => setDrawerId(null)} />
      {editLead && <CallDialog lead={editLead} onClose={() => setEditLead(null)} />}
    </>
  );
}
