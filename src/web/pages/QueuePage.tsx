import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Dashboard, DddCount, LeadItem, PullResult, QueueResponse } from '../../shared/api';
import { CallDialog } from '../components/CallDialog';
import { ChatButton } from '../components/ChatButton';
import {
  IconArrowRight,
  IconBlock,
  IconChat,
  IconCheck,
  IconClock,
  IconCopy,
  IconDots,
  IconFocus,
  IconGrid,
  IconHistory,
  IconNote,
  IconPhone,
  IconPlus,
  IconSearch,
  IconUndo,
} from '../components/Icons';
import { LeadDrawer } from '../components/LeadDrawer';
import { useQueueStats, useTopbarCenter } from '../components/Shell';
import { useToast } from '../components/Toasts';
import { Confirm, copyText, Empty, hue, Menu, Skeleton } from '../components/ui';
import { api, errorMessage, qs } from '../lib/api';
import { fmtN, fmtWhen, plural } from '../lib/format';
import { useDebounced, useShortcuts } from '../lib/hooks';
import { companyInitials, leadLabel, leadPartner, useLeadActions } from '../lib/leads';
import { useLocalFlag } from '../lib/prefs';
import { useMe, useSession } from '../lib/session';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

function Extras({ lead, max = 3 }: { lead: LeadItem; max?: number }) {
  return (
    <>
      {Object.entries(lead.extra)
        .slice(0, max)
        .map(([k, v]) => (
          <span key={k} className="x">
            <b>{k}:</b> {v}
          </span>
        ))}
    </>
  );
}

interface RowHandlers {
  onMark: (l: LeadItem) => void;
  onNoWa: (l: LeadItem) => void;
  onDialog: (l: LeadItem) => void;
  onHistory: (l: LeadItem) => void;
  onRelease: (l: LeadItem) => void;
  onOptOut: (l: LeadItem) => void;
}

function LeadRow({ lead, h }: { lead: LeadItem; h: RowHandlers }) {
  const toast = useToast();
  const copy = async (text: string, what: string) =>
    toast((await copyText(text)) ? `${what} copiado.` : 'Não deu para copiar.');
  return (
    <li className={`lead${lead.whatsappOpenedAt ? ' opened' : ''}`}>
      <span
        className="lead-ava"
        aria-hidden="true"
        style={{ '--h': hue(leadLabel(lead)) } as React.CSSProperties}
      >
        {companyInitials(leadLabel(lead))}
      </span>
      <div className="lead-main">
        <div className="lead-name">
          <button type="button" onClick={() => h.onHistory(lead)}>
            {leadLabel(lead)}
          </button>
        </div>
        {leadPartner(lead) && <div className="lead-socio">Sócio: {leadPartner(lead)}</div>}
        <div className="lead-meta">
          <span className="phone">
            <IconPhone />
            {lead.phoneDisplay}
          </span>
          {lead.phoneType === 'fixo' && (
            <span className="tag warn" title="Telefone fixo: pode não ter WhatsApp">
              Fixo
            </span>
          )}
          <span className="tag">{lead.list.name}</span>
          <Extras lead={lead} />
          {lead.whatsappOpenedAt && (
            <span className="opened-note">WhatsApp aberto {fmtWhen(lead.whatsappOpenedAt)}</span>
          )}
        </div>
        {lead.note && <div className="note-text">{lead.note}</div>}
      </div>
      <div className="lead-act">
        <ChatButton lead={lead} className="btn btn-wa">
          <IconChat />
          Chamar no WhatsApp
        </ChatButton>
        <button
          type="button"
          className="btn btn-line btn-done"
          aria-label="Marcar como chamado"
          onClick={() => h.onMark(lead)}
        >
          <IconCheck />
          <span className="lg-only">Marcar como chamado</span>
          <span className="sm-only">Chamado</span>
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          title="O número não tem WhatsApp"
          onClick={() => h.onNoWa(lead)}
        >
          Sem WhatsApp
        </button>
        <Menu label="Mais ações" icon={<IconDots />}>
          <button type="button" role="menuitem" onClick={() => h.onDialog(lead)}>
            <IconNote /> Registrar com resultado e observação
          </button>
          <button type="button" role="menuitem" onClick={() => h.onHistory(lead)}>
            <IconHistory /> Ver histórico
          </button>
          <button type="button" role="menuitem" onClick={() => copy(lead.phoneDisplay, 'Número')}>
            <IconCopy /> Copiar número
          </button>
          <button type="button" role="menuitem" onClick={() => h.onRelease(lead)}>
            <IconUndo /> Devolver à fila livre
          </button>
          <hr />
          <button type="button" role="menuitem" className="danger" onClick={() => h.onOptOut(lead)}>
            <IconBlock /> Não quer contato (bloquear número)
          </button>
        </Menu>
      </div>
    </li>
  );
}

function CallbackRow({ lead, h }: { lead: LeadItem; h: RowHandlers }) {
  const overdue = lead.callbackAt ? Date.parse(lead.callbackAt) < Date.now() : false;
  return (
    <li className={`lead${overdue ? ' overdue' : ''}`}>
      <span className="lead-ava cb" aria-hidden="true">
        <IconClock size={18} />
      </span>
      <div className="lead-main">
        <div className="lead-name">
          <button type="button" onClick={() => h.onHistory(lead)}>
            {leadLabel(lead)}
          </button>
        </div>
        {leadPartner(lead) && <div className="lead-socio">Sócio: {leadPartner(lead)}</div>}
        <div className="lead-meta">
          <span className={`tag ${overdue ? 'warn' : 'info'}`}>
            <IconClock size={12} /> {overdue ? 'Atrasado · ' : ''}
            {fmtWhen(lead.callbackAt)}
          </span>
          <span className="phone">{lead.phoneDisplay}</span>
          <span className="tag">{lead.list.name}</span>
        </div>
        {lead.note && <div className="note-text">{lead.note}</div>}
      </div>
      <div className="lead-act">
        <ChatButton lead={lead} className="btn btn-wa btn-sm">
          <IconChat size={16} />
          Chamar
        </ChatButton>
        <button type="button" className="btn btn-line btn-sm" onClick={() => h.onDialog(lead)}>
          Registrar retorno
        </button>
      </div>
    </li>
  );
}

function FocusMode({
  items,
  h,
  onExit,
  pullButton,
}: {
  items: LeadItem[];
  h: RowHandlers;
  onExit: () => void;
  pullButton: React.ReactNode;
}) {
  const { config } = useSession();
  const [pos, setPos] = useState(0);
  const waRef = useRef<HTMLSpanElement>(null);
  const lead = items[Math.min(pos, Math.max(0, items.length - 1))];
  const index = lead ? items.indexOf(lead) : 0;

  useShortcuts({
    w: () => waRef.current?.querySelector('button')?.click(),
    Enter: () => waRef.current?.querySelector('button')?.click(),
    c: () => lead && h.onMark(lead),
    s: () => lead && h.onNoWa(lead),
    r: () => lead && h.onDialog(lead),
    h: () => lead && h.onHistory(lead),
    p: () => setPos((p) => (items.length ? (p + 1) % items.length : 0)),
    ArrowRight: () => setPos((p) => (items.length ? (p + 1) % items.length : 0)),
    ArrowLeft: () => setPos((p) => (items.length ? (p - 1 + items.length) % items.length : 0)),
    Escape: onExit,
  });

  if (!lead) {
    return (
      <div className="focus-card">
        <Empty title="Fila vazia">
          <p>Você chamou todos os leads da sua fila.</p>
          {pullButton}
        </Empty>
      </div>
    );
  }
  return (
    <>
      <div className="focus-top">
        <span className="sub">
          Lead {fmtN(index + 1)} de {fmtN(items.length)} carregados
        </span>
        <div className="row">
          <span className="sub small kbd-hint">
            Atalhos:{' '}
            {config?.whatsapp && (
              <>
                <kbd>W</kbd> chamar ·{' '}
              </>
            )}
            <kbd>C</kbd> chamado · <kbd>S</kbd> sem WhatsApp · <kbd>R</kbd> resultado · <kbd>P</kbd> pular
          </span>
          <button type="button" className="btn btn-line btn-sm" onClick={onExit}>
            Sair do modo foco <kbd>Esc</kbd>
          </button>
        </div>
      </div>
      <article className={`focus-card${lead.whatsappOpenedAt ? ' opened' : ''}`} aria-live="polite">
        <div className="who">
          <span className="eyebrow">{lead.list.name}</span>
          <span className="name">{leadLabel(lead)}</span>
          {leadPartner(lead) && <span className="lead-socio">Sócio / proprietário: {leadPartner(lead)}</span>}
          <div className="lead-meta" style={{ fontSize: 14 }}>
            <span className="phone">{lead.phoneDisplay}</span>
            {lead.phoneType === 'fixo' && <span className="tag warn">Fixo</span>}
            {lead.extraPhones.length > 0 && (
              <span>Outros: {lead.extraPhones.map((p) => p.display).join(' · ')}</span>
            )}
          </div>
        </div>
        {Object.keys(lead.extra).length > 0 && (
          <div className="focus-extras">
            {Object.entries(lead.extra).map(([k, v]) => (
              <div key={k}>
                <span>{k}</span>
                {v}
              </div>
            ))}
          </div>
        )}
        {lead.note && <div className="note-text">{lead.note}</div>}
        <div className="focus-actions">
          <span ref={waRef} style={{ display: 'contents' }}>
            <ChatButton lead={lead} className="btn btn-wa btn-lg">
              <IconChat />
              Chamar no WhatsApp <kbd>W</kbd>
            </ChatButton>
          </span>
          <button
            type="button"
            className={`btn btn-lg ${lead.whatsappOpenedAt ? 'btn-primary' : 'btn-line'}`}
            onClick={() => h.onMark(lead)}
          >
            <IconCheck />
            Marcar como chamado <kbd>C</kbd>
          </button>
          <button type="button" className="btn btn-line btn-lg" onClick={() => h.onNoWa(lead)}>
            Sem WhatsApp <kbd>S</kbd>
          </button>
        </div>
        <div className="row">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => h.onDialog(lead)}>
            <IconNote size={15} /> Resultado e observação <kbd>R</kbd>
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => h.onHistory(lead)}>
            <IconHistory size={15} /> Histórico <kbd>H</kbd>
          </button>
          <span className="grow" />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setPos((p) => (p + 1) % items.length)}
          >
            Pular <IconArrowRight size={15} /> <kbd>P</kbd>
          </button>
        </div>
      </article>
    </>
  );
}

function Onboarding() {
  const { can } = useSession();
  const d = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<Dashboard>('/dashboard'),
    enabled: can('manageLeads'),
  });
  if (!can('manageLeads') || !d.data || d.data.totals.leads > 0) return null;
  const hasTeam = d.data.perAttendant.length > 1;
  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <h2>Deixe o sistema pronto em 3 passos</h2>
      <p className="sub mt8">Depois disso, cada atendente entra com o próprio login e começa a chamar.</p>
      <ol className="stack mt12" style={{ gap: 10, paddingLeft: 20 }}>
        <li>
          <b>Cadastre a equipe</b> {hasTeam ? '✓' : ''} ·{' '}
          {can('manageUsers') ? <Link to="/usuarios">abrir Usuários</Link> : 'peça ao administrador'}
        </li>
        <li>
          <b>Importe uma lista</b> (Excel ou CSV) · <Link to="/listas">abrir Listas</Link>
        </li>
        <li>
          <b>Envie o link de acesso</b> para cada atendente (aparece ao cadastrar).
        </li>
      </ol>
    </section>
  );
}

export function QueuePage() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const actions = useLeadActions();
  const [focus, setFocus] = useLocalFlag('cl_focus', false);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 250);
  const [limit, setLimit] = useState(50);
  const [pulling, setPulling] = useState(false);
  const [dialogLead, setDialogLead] = useState<LeadItem | null>(null);
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [optOutLead, setOptOutLead] = useState<LeadItem | null>(null);
  /** Filtro de DDD da própria fila e DDD escolhido para pegar leads. */
  const [dddView, setDddView] = useState('');
  const [pullDdd, setPullDdd] = useState('');
  const [qty, setQty] = useState(10);
  const searchRef = useRef<HTMLInputElement>(null);
  const stats = useQueueStats();
  const queue = useQuery({
    queryKey: ['queue', q, limit, dddView],
    queryFn: () => api<QueueResponse>(`/queue${qs({ q, limit, ddd: dddView })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const freeDdds = useQuery({
    queryKey: ['queue-ddds'],
    queryFn: () => api<DddCount[]>('/queue/ddds'),
    refetchInterval: 30_000,
  });

  const s = stats.data;
  const room = s && s.maxQueue > 0 ? Math.max(0, s.maxQueue - s.minhaFila) : Number.POSITIVE_INFINITY;
  const dailyLeft =
    s && s.limiteDiario > 0 ? Math.max(0, s.limiteDiario - s.pegouHoje) : Number.POSITIVE_INFINITY;
  const freeHere = pullDdd ? (freeDdds.data?.find((d) => d.ddd === pullDdd)?.count ?? 0) : (s?.livres ?? 0);
  // Máximo que dá para pedir agora: por pedido, espaço na fila, limite do dia e leads livres.
  const maxNow = s ? Math.min(s.pullSize, room, dailyLeft, freeHere) : 0;
  const qtyOptions = [
    ...new Set([1, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500, 1000, maxNow]),
  ]
    .filter((n) => n >= 1 && n <= maxNow)
    .sort((a, b) => a - b);
  const pullQty = Math.max(1, Math.min(qty, maxNow));

  async function pull() {
    setPulling(true);
    try {
      const r = await api<PullResult>('/queue/pull', {
        body: { quantity: pullQty, ddd: pullDdd || null },
      });
      toast(
        r.count
          ? `${plural(r.count, 'lead entrou', 'leads entraram')} na sua fila.`
          : 'Não há leads livres agora. Outro atendente pode ter pegado os últimos.',
      );
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    } finally {
      setPulling(false);
      qc.invalidateQueries({ queryKey: ['queue'] });
      qc.invalidateQueries({ queryKey: ['queue-stats'] });
      qc.invalidateQueries({ queryKey: ['queue-ddds'] });
    }
  }

  const handlers: RowHandlers = useMemo(
    () => ({
      onMark: (l) => void actions.markCalled(l, 'enviado'),
      onNoWa: (l) => void actions.markCalled(l, 'sem_whatsapp'),
      onDialog: (l) => setDialogLead(l),
      onHistory: (l) => setDrawerId(l.id),
      onRelease: (l) => void actions.requeue(l, 'livre'),
      onOptOut: (l) => setOptOutLead(l),
    }),
    [actions],
  );

  useShortcuts({ '/': () => searchRef.current?.focus(), f: () => setFocus(!focus) }, !focus);

  // Seletor Lista / Modo foco no meio da barra de cima (computador).
  useTopbarCenter(
    <div className="seg-float" role="radiogroup" aria-label="Como ver a fila">
      <button type="button" role="radio" aria-checked={!focus} title="Lista" onClick={() => setFocus(false)}>
        <IconGrid />
        <span className="vh">Lista</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={focus}
        title="Modo foco"
        onClick={() => setFocus(true)}
      >
        <IconFocus size={20} />
        <span className="vh">Modo foco</span>
      </button>
    </div>,
    focus,
  );

  const blockedReason =
    dailyLeft === 0
      ? 'Limite do dia atingido'
      : room === 0
        ? 'Sua fila está cheia'
        : pullDdd && freeHere === 0
          ? 'Sem leads livres neste DDD'
          : 'Fila livre vazia';

  const pullButton = (
    <div className="pull-box">
      <label className="vh" htmlFor="pull-qty">
        Quantos leads pegar
      </label>
      <select
        id="pull-qty"
        className="select"
        value={pullQty}
        disabled={!maxNow || pulling}
        onChange={(e) => setQty(Number(e.target.value))}
        title="Quantos leads pegar da fila"
      >
        {(qtyOptions.length ? qtyOptions : [0]).map((n) => (
          <option key={n} value={n}>
            {fmtN(n)} {n === 1 ? 'lead' : 'leads'}
          </option>
        ))}
      </select>
      <label className="vh" htmlFor="pull-ddd">
        De qual DDD
      </label>
      <select
        id="pull-ddd"
        className="select"
        value={pullDdd}
        disabled={pulling}
        onChange={(e) => setPullDdd(e.target.value)}
        title="Pegar só leads de um DDD"
      >
        <option value="">Todos os DDDs ({fmtN(s?.livres)})</option>
        {freeDdds.data?.map((d) => (
          <option key={d.ddd} value={d.ddd}>
            DDD {d.ddd} ({fmtN(d.count)})
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-primary" disabled={!maxNow || pulling} onClick={pull}>
        {pulling ? (
          'Pegando…'
        ) : maxNow ? (
          <>
            <IconPlus />
            Pegar leads
          </>
        ) : (
          blockedReason
        )}
      </button>
      {!!s?.limiteDiario && (
        <span className="daily-note">
          Hoje você pegou {fmtN(s.pegouHoje)} de {fmtN(s.limiteDiario)} leads (limite diário)
        </span>
      )}
    </div>
  );

  const items = queue.data?.items ?? [];
  const callbacks = queue.data?.callbacks ?? [];
  const dueCallbacks = callbacks.filter(
    (c) => c.callbackAt && Date.parse(c.callbackAt) < Date.now() + 12 * 3_600_000,
  );
  const laterCallbacks = callbacks.length - dueCallbacks.length;

  return (
    <>
      <Onboarding />
      <div className="page-head desk-head">
        <div>
          <p className="eyebrow">{greeting()}</p>
          <h1>Olá, {me.name.split(' ')[0]}</h1>
          <p className="sub">Atendendo como {me.name}</p>
        </div>
        <div className="pull-card">{pullButton}</div>
      </div>

      <div className="kpis">
        <div className="kpi">
          <p className="kpi-l">Na sua fila</p>
          <p className="kpi-v">{fmtN(s?.minhaFila)}</p>
          <p className="kpi-s">
            <span className="dot warn" />
            Retornos hoje <b>{fmtN(s?.retornosHoje)}</b>
          </p>
        </div>
        <div className="kpi">
          <p className="kpi-l">Você chamou hoje</p>
          <p className="kpi-v">{fmtN(s?.chameiHoje)}</p>
          <p className="kpi-s">
            <span className="dot bad" />
            Sem WhatsApp <b>{fmtN(s?.semWhatsappHoje)}</b>
          </p>
        </div>
        <div className="kpi">
          <p className="kpi-l">Pegou hoje</p>
          <p className="kpi-v">
            {fmtN(s?.pegouHoje)}
            {!!s?.limiteDiario && <small> / {fmtN(s.limiteDiario)}</small>}
          </p>
          {s?.limiteDiario ? (
            <div className="progress kpi-bar" title="Limite diário">
              <i style={{ width: `${Math.min(100, ((s.pegouHoje ?? 0) / s.limiteDiario) * 100)}%` }} />
            </div>
          ) : (
            <p className="kpi-s">Sem limite diário</p>
          )}
        </div>
        <div className="kpi">
          <p className="kpi-l">Livres para pegar</p>
          <p className="kpi-v">{fmtN(s?.livres)}</p>
          <p className="kpi-s">
            <span className="dot ok" />
            Na fila livre
          </p>
        </div>
      </div>

      {dueCallbacks.length > 0 && !focus && (
        <section>
          <h2 className="section-title">
            <IconClock /> Retornos agendados
          </h2>
          <ul className="leads">
            {dueCallbacks.map((l) => (
              <CallbackRow key={l.id} lead={l} h={handlers} />
            ))}
          </ul>
          {laterCallbacks > 0 && (
            <p className="sub mt8">
              E mais {plural(laterCallbacks, 'retorno', 'retornos')} para os próximos dias (veja em Já
              chamados).
            </p>
          )}
          <h2 className="section-title" style={{ marginTop: 26 }}>
            Sua fila
          </h2>
        </section>
      )}

      <div className="toolbar">
        {!focus && (
          <div className="search">
            <IconSearch />
            <label className="vh" htmlFor="q-queue">
              Buscar na sua fila
            </label>
            <input
              ref={searchRef}
              id="q-queue"
              className="input"
              type="search"
              placeholder="Buscar empresa, sócio ou telefone"
              autoComplete="off"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setLimit(50);
              }}
            />
          </div>
        )}
        <div className="prefs">
          <label className="vh" htmlFor="ddd-view">
            Filtrar sua fila por DDD
          </label>
          <select
            id="ddd-view"
            className="select"
            value={dddView}
            onChange={(e) => {
              setDddView(e.target.value);
              setLimit(50);
            }}
            title="Mostrar só os leads da sua fila deste DDD"
          >
            <option value="">Sua fila: todos os DDDs</option>
            {queue.data?.ddds.map((d) => (
              <option key={d.ddd} value={d.ddd}>
                Sua fila: DDD {d.ddd} ({fmtN(d.count)})
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`btn btn-sm hide-lg ${focus ? 'btn-primary' : 'btn-line'}`}
            aria-pressed={focus}
            onClick={() => setFocus(!focus)}
          >
            <IconFocus size={15} />
            Modo foco
          </button>
        </div>
      </div>

      {queue.isLoading ? (
        <Skeleton rows={5} />
      ) : focus ? (
        <FocusMode items={items} h={handlers} onExit={() => setFocus(false)} pullButton={pullButton} />
      ) : items.length === 0 ? (
        <ul className="leads">
          <li style={{ listStyle: 'none' }}>
            {q ? (
              <Empty title="Nada encontrado">
                <p>Nenhum lead da sua fila combina com “{q}”.</p>
              </Empty>
            ) : s && s.livres > 0 ? (
              <Empty title="Sua fila está vazia">
                <p>
                  Tem {plural(s.livres, 'lead livre', 'leads livres')} esperando. Pegue alguns para começar.
                </p>
                {pullButton}
              </Empty>
            ) : (
              <Empty title="Tudo chamado por aqui">
                <p>
                  Não há leads livres na fila. Quando o gestor importar uma nova lista, eles aparecem aqui.
                </p>
              </Empty>
            )}
          </li>
        </ul>
      ) : (
        <ul className="leads">
          {items.map((l) => (
            <LeadRow key={l.id} lead={l} h={handlers} />
          ))}
          {(queue.data?.total ?? 0) > items.length && (
            <li className="more">
              <button type="button" className="btn btn-line" onClick={() => setLimit(limit + 50)}>
                Mostrar mais ({fmtN((queue.data?.total ?? 0) - items.length)})
              </button>
            </li>
          )}
        </ul>
      )}

      {dialogLead && <CallDialog lead={dialogLead} onClose={() => setDialogLead(null)} />}
      <LeadDrawer leadId={drawerId} onClose={() => setDrawerId(null)} />
      <Confirm
        open={!!optOutLead}
        title="Bloquear este número?"
        confirmLabel="Bloquear número"
        danger
        onClose={() => setOptOutLead(null)}
        onConfirm={() => {
          if (optOutLead) void actions.optOut(optOutLead);
          setOptOutLead(null);
        }}
      >
        <p>
          <b>{optOutLead && leadLabel(optOutLead)}</b> ({optOutLead?.phoneDisplay}) pediu para não ser mais
          contatado. O número vai para a lista de não contatar e nunca mais entra na fila, em nenhuma lista.
        </p>
      </Confirm>
    </>
  );
}
