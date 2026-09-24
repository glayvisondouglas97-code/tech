import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ACTIVITY_CATEGORIES, actionLabel } from '../../shared/activity';
import type { ActivityItem, ActivitySummary, Page, TeamMember } from '../../shared/api';
import { resultLabel } from '../../shared/results';
import { ROLE_LABELS } from '../../shared/roles';
import { IconDown } from '../components/Icons';
import { Avatar, Pager, Skeleton } from '../components/ui';
import { api, qs } from '../lib/api';
import { fmtDayShort, fmtN, fmtWhen, ymdSP } from '../lib/format';

type PeriodKey = 'hoje' | 'ontem' | '7d' | '30d' | 'datas';

function range(key: PeriodKey, from: string, to: string): { from: string; to: string } {
  const today = ymdSP();
  const daysAgo = (n: number) => ymdSP(new Date(Date.now() - n * 86_400_000));
  if (key === 'ontem') return { from: daysAgo(1), to: daysAgo(1) };
  if (key === '7d') return { from: daysAgo(6), to: today };
  if (key === '30d') return { from: daysAgo(29), to: today };
  if (key === 'datas') return { from: from || today, to: to || from || today };
  return { from: today, to: today };
}

/** Texto dos detalhes de cada ação no registro. */
function details(i: ActivityItem): string {
  const d = i.details as Record<string, string | number | boolean | null | undefined>;
  switch (i.action) {
    case 'pediu_leads':
      return `Pediu ${d.solicitados}, recebeu ${d.recebidos}${d.ddd && d.ddd !== 'todos' ? ` (DDD ${d.ddd})` : ''}`;
    case 'pegou':
      return d.ddd ? `DDD ${d.ddd}` : '';
    case 'chamado':
      return resultLabel(String(d.resultado ?? 'enviado'));
    case 'resultado':
      return `${d.de ? resultLabel(String(d.de)) : '—'} → ${resultLabel(String(d.para))}`;
    case 'importado':
    case 'atribuido':
      return [
        d.lista ? `Lista ${d.lista}` : null,
        d.para_nome ? `para ${d.para_nome}` : null,
        d.de_nome ? `estava com ${d.de_nome}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'devolvido':
    case 'expirado':
      return [d.de_nome ? `estava com ${d.de_nome}` : null, d.motivo].filter(Boolean).join(' · ');
    case 'observacao':
      return String(d.texto ?? '');
    case 'acesso_negado':
      return `${d.metodo} ${d.rota}`;
    default:
      return Object.entries(d)
        .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
        .join(' · ');
  }
}

export function AuditPage() {
  const [period, setPeriod] = useState<PeriodKey>('hoje');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [userId, setUserId] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const r = range(period, from, to);
  const team = useQuery({ queryKey: ['team'], queryFn: () => api<TeamMember[]>('/team'), staleTime: 60_000 });
  const summary = useQuery({
    queryKey: ['activity-summary', r],
    queryFn: () => api<ActivitySummary>(`/activity/summary${qs(r)}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const feedParams = { ...r, userId, category, page };
  const feed = useQuery({
    queryKey: ['activity-feed', feedParams],
    queryFn: () => api<Page<ActivityItem>>(`/activity/feed${qs(feedParams)}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const s = summary.data;
  const reset = () => setPage(1);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Auditoria</h1>
          <p className="sub">
            Tudo o que cada pessoa fez no sistema: pedidos de leads, contatos, mudanças e acessos.
          </p>
        </div>
        <div className="row">
          <select
            className="select input"
            style={{ width: 'auto' }}
            aria-label="Período"
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value as PeriodKey);
              reset();
            }}
          >
            <option value="hoje">Hoje</option>
            <option value="ontem">Ontem</option>
            <option value="7d">Últimos 7 dias</option>
            <option value="30d">Últimos 30 dias</option>
            <option value="datas">Escolher datas…</option>
          </select>
          {period === 'datas' && (
            <>
              <input
                className="input"
                type="date"
                aria-label="De"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
              <input
                className="input"
                type="date"
                aria-label="Até"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </>
          )}
        </div>
      </div>

      {!s ? (
        <Skeleton rows={4} />
      ) : (
        <>
          <div className="tiles">
            <div className="tile">
              <p className="eyebrow">Quem mais puxou leads</p>
              <p className="v">{s.topPuller ? fmtN(s.topPuller.count) : '—'}</p>
              <p className="s">{s.topPuller?.user.name ?? 'ninguém no período'}</p>
            </div>
            <div className="tile">
              <p className="eyebrow">Quem mais chamou</p>
              <p className="v">{s.topCaller ? fmtN(s.topCaller.count) : '—'}</p>
              <p className="s">{s.topCaller?.user.name ?? 'ninguém no período'}</p>
            </div>
            <div className="tile">
              <p className="eyebrow">Leads puxados</p>
              <p className="v">{fmtN(s.users.reduce((n, u) => n + u.puxados, 0))}</p>
              <p className="s">em {fmtN(s.users.reduce((n, u) => n + u.pedidos, 0))} pedidos</p>
            </div>
            <div className="tile">
              <p className="eyebrow">Ações registradas</p>
              <p className="v">{fmtN(s.users.reduce((n, u) => n + u.acoes, 0))}</p>
              <p className="s">
                {s.from === s.to
                  ? fmtDayShort(s.from).label
                  : `${fmtDayShort(s.from).label} a ${fmtDayShort(s.to).label}`}
              </p>
            </div>
          </div>

          <section className="panel">
            <h2>Por pessoa</h2>
            <div className="tbl-wrap" style={{ marginTop: 10 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Pessoa</th>
                    <th title="Quantas vezes clicou em Pegar leads">Pedidos</th>
                    <th>Puxados</th>
                    <th title="Recebidos por distribuição na importação ou do gestor">Recebidos</th>
                    <th>WhatsApp aberto</th>
                    <th>Chamados</th>
                    <th>Sem WhatsApp</th>
                    <th>Resultados mudados</th>
                    <th>Devolvidos / desfeitos</th>
                    <th title="Tentativas de acessar algo sem permissão">Acessos negados</th>
                    <th>Total de ações</th>
                  </tr>
                </thead>
                <tbody>
                  {s.users.map((u) => (
                    <tr key={u.user.id}>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                          <Avatar name={u.user.name} />
                          <span>
                            <b style={{ fontWeight: 600 }}>{u.user.name}</b>
                            <span className="sub small"> {ROLE_LABELS[u.user.role].toLowerCase()}</span>
                            {s.topPuller?.user.id === u.user.id && (
                              <span className="badge-top">mais puxou</span>
                            )}
                            {s.topCaller?.user.id === u.user.id && (
                              <span className="badge-top">mais chamou</span>
                            )}
                          </span>
                        </span>
                      </td>
                      <td>{fmtN(u.pedidos)}</td>
                      <td>
                        <b>{fmtN(u.puxados)}</b>
                      </td>
                      <td>{fmtN(u.recebidos)}</td>
                      <td>{fmtN(u.abriuWhatsapp)}</td>
                      <td>
                        <b>{fmtN(u.chamados)}</b>
                      </td>
                      <td>{fmtN(u.semWhatsapp)}</td>
                      <td>{fmtN(u.resultados)}</td>
                      <td>{fmtN(u.devolvidos)}</td>
                      <td style={u.acessosNegados ? { color: 'var(--bad)', fontWeight: 700 } : undefined}>
                        {fmtN(u.acessosNegados)}
                      </td>
                      <td>{fmtN(u.acoes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {s.daily.length > 0 && (
            <section className="panel">
              <h2>Por dia</h2>
              <p className="sub">Quantos leads cada pessoa puxou da fila e chamou, dia a dia.</p>
              <div className="tbl-wrap" style={{ marginTop: 10 }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Dia</th>
                      <th className="l">Pessoa</th>
                      <th>Puxados</th>
                      <th>Chamados</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.daily.map((d) => {
                      const day = fmtDayShort(d.day);
                      return (
                        <tr key={`${d.day}-${d.user.id}`}>
                          <td>
                            {day.weekday} {day.label}
                          </td>
                          <td className="l">{d.user.name}</td>
                          <td>{fmtN(d.puxados)}</td>
                          <td>{fmtN(d.chamados)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Registro detalhado</h2>
            <p className="sub">
              Cada ação com quem fez, quando e em qual lead. Do mais novo para o mais antigo.
            </p>
          </div>
          <a
            className="btn btn-line btn-sm"
            href={`/api/activity/feed.csv${qs({ ...r, userId, category })}`}
            download
          >
            <IconDown /> Baixar planilha (CSV)
          </a>
        </div>
        <div className="row" style={{ marginBottom: 12 }}>
          <select
            className="select input"
            style={{ maxWidth: 260 }}
            aria-label="Pessoa"
            value={userId}
            onChange={(e) => {
              setUserId(e.target.value);
              reset();
            }}
          >
            <option value="">Todas as pessoas</option>
            {team.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <select
            className="select input"
            style={{ maxWidth: 320 }}
            aria-label="Tipo de ação"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              reset();
            }}
          >
            <option value="">Todas as ações</option>
            {Object.entries(ACTIVITY_CATEGORIES).map(([k, c]) => (
              <option key={k} value={k}>
                {c.label}
              </option>
            ))}
          </select>
          <span className="sub">{feed.data ? `${fmtN(feed.data.total)} registros` : ''}</span>
        </div>
        <div className="tbl-wrap">
          <table className="tbl" style={{ opacity: feed.isPlaceholderData ? 0.6 : 1 }}>
            <thead>
              <tr>
                <th className="l">Quando</th>
                <th className="l">Quem</th>
                <th className="l">Ação</th>
                <th className="l">Empresa</th>
                <th className="l">Detalhes</th>
              </tr>
            </thead>
            <tbody>
              {feed.data?.items.map((i) => (
                <tr key={i.id}>
                  <td className="l sub" style={{ whiteSpace: 'nowrap' }}>
                    {fmtWhen(i.createdAt)}
                  </td>
                  <td className="l">{i.user?.name ?? 'Sistema'}</td>
                  <td className="l">{actionLabel(i.action)}</td>
                  <td className="l">
                    {i.lead ? i.lead.company || i.lead.name || `Lead ${i.lead.id}` : ''}
                    {i.lead?.company && i.lead.name && <div className="sub small">Sócio: {i.lead.name}</div>}
                  </td>
                  <td className="l sub small" style={{ maxWidth: 360, overflowWrap: 'anywhere' }}>
                    {details(i)}
                    {i.ip && <div>IP {i.ip}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {feed.data && !feed.data.items.length && <p className="sub mt8">Nada registrado neste filtro.</p>}
        <Pager
          page={page}
          pageSize={feed.data?.pageSize ?? 50}
          total={feed.data?.total ?? 0}
          onPage={setPage}
        />
      </section>
    </div>
  );
}
