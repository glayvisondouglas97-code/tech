import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AttendantStats, Dashboard } from '../../shared/api';
import { resultInfo } from '../../shared/results';
import { ROLE_LABELS } from '../../shared/roles';
import { IconDown } from '../components/Icons';
import { Sparkline } from '../components/Sparkline';
import { useToast } from '../components/Toasts';
import { Avatar, Confirm, Skeleton } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { fmtDayShort, fmtN, fmtPct, fmtWhen, plural, ymdSP } from '../lib/format';
import { useSession } from '../lib/session';

function pct(n: number, total: number) {
  return total ? `${((n / total) * 100).toFixed(2)}%` : '0%';
}

function DailyChart({ daily }: { daily: Dashboard['daily'] }) {
  const today = ymdSP();
  const calls = daily.reduce((a, d) => a + d.count, 0);
  const noWa = daily.reduce((a, d) => a + d.semWhatsapp, 0);
  return (
    <div className="chart">
      <Sparkline
        height={170}
        label={`Chamados por dia nos últimos 14 dias: ${daily.map((d) => d.count).join(', ')}`}
        series={[
          { values: daily.map((d) => d.count), tone: 'ok' },
          { values: daily.map((d) => d.semWhatsapp), tone: 'bad' },
        ]}
      />
      <div className="chart-x" aria-hidden="true">
        {daily.map((d) => (
          <span key={d.day} className={d.day === today ? 'today' : ''}>
            {d.day === today ? 'hoje' : fmtDayShort(d.day).weekday}
          </span>
        ))}
      </div>
      <div className="legend-2">
        <div>
          <span className="eyebrow">
            <span className="dot ok" /> Chamados
          </span>
          <b>{fmtN(calls)}</b>
        </div>
        <div className="r">
          <span className="eyebrow">
            <span className="dot bad" /> Sem WhatsApp
          </span>
          <b>{fmtN(noWa)}</b>
        </div>
      </div>
    </div>
  );
}

/** Cartão de cada pessoa: chamados de hoje em destaque, 14 dias no minigráfico e os números embaixo. */
function AttendantCard({ a, highlight }: { a: AttendantStats; highlight: boolean }) {
  return (
    <article className={`acard${highlight ? ' hl' : ''}`}>
      <header className="acard-head">
        <h3>{a.user.name}</h3>
        <span className={`count-badge${highlight ? ' dark' : ''}`} title="Leads na fila agora">
          {fmtN(a.fila)}
        </span>
      </header>
      <div className="acard-who">
        <Avatar name={a.user.name} />
        <span className="sub small">
          {!a.user.active ? 'desativado' : ROLE_LABELS[a.user.role]}
          {highlight && ' · quem mais chamou hoje'}
        </span>
      </div>
      <p className="eyebrow">Chamados hoje</p>
      <p className="acard-v">{fmtN(a.hoje)}</p>
      <Sparkline
        height={84}
        label={`${a.user.name}, chamados nos últimos 14 dias: ${a.spark.chamados.join(', ')}`}
        series={[
          { values: a.spark.chamados, tone: 'ok' },
          { values: a.spark.semWhatsapp, tone: 'bad' },
        ]}
      />
      <div className="legend-2">
        <div>
          <span className="eyebrow">
            <span className="dot ok" /> 7 dias
          </span>
          <b>{fmtN(a.d7)}</b>
        </div>
        <div className="r">
          <span className="eyebrow">
            <span className="dot bad" /> Sem WhatsApp
          </span>
          <b>{fmtN(a.semWhatsapp)}</b>
        </div>
      </div>
      <dl className="soft-box">
        <div>
          <dt>30 dias</dt>
          <dd>{fmtN(a.d30)}</dd>
        </div>
        <div>
          <dt>Interessados</dt>
          <dd>{fmtN(a.interessados)}</dd>
        </div>
        <div>
          <dt>Fecharam</dt>
          <dd>
            {fmtN(a.fechados)}
            {a.conversao != null && <span className="sub"> · {fmtPct(a.conversao)}</span>}
          </dd>
        </div>
      </dl>
    </article>
  );
}

export function DashboardPage() {
  const { can } = useSession();
  const manager = can('seeAllLeads');
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmStale, setConfirmStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const d = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<Dashboard>('/dashboard'),
    refetchInterval: 30_000,
  });

  if (d.isLoading || !d.data) return <Skeleton rows={4} />;
  const { totals: t, perAttendant, results, lists, daily, stale } = d.data;
  const pending = t.comAtendentes + t.livres;
  const reached = t.chamados + t.semWhatsapp;
  const topToday = Math.max(0, ...perAttendant.map((p) => p.hoje));
  const totalResults = results.reduce((a, r) => a + r.count, 0);
  const fechados = results.find((r) => r.result === 'fechou')?.count ?? 0;
  const interessados = results.find((r) => r.result === 'interessado')?.count ?? 0;
  const me = perAttendant[0];

  async function releaseStale() {
    setBusy(true);
    try {
      const r = await api<{ released: number }>('/leads/release', {
        body: { olderThanHours: stale.hours, onlyNotOpened: false },
      });
      toast(`${plural(r.released, 'lead voltou', 'leads voltaram')} para a fila livre.`);
      qc.invalidateQueries();
    } catch (err) {
      toast(errorMessage(err), { tone: 'bad' });
    } finally {
      setBusy(false);
      setConfirmStale(false);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{manager ? 'Painel' : 'Meu desempenho'}</h1>
          <p className="sub">Atualiza sozinho a cada 30 segundos · {fmtWhen(d.data.generatedAt)}</p>
        </div>
        {can('exportData') && t.leads > 0 && (
          <div className="row">
            <a className="btn btn-line btn-sm" href="/api/export/leads.csv?view=todos" download>
              <IconDown /> Base completa (CSV)
            </a>
            <a className="btn btn-line btn-sm" href="/api/export/leads.xlsx?view=todos" download>
              <IconDown /> Excel
            </a>
          </div>
        )}
      </div>

      {manager && stale.count > 0 && (
        <div className="banner row">
          <span className="grow">
            <b>{plural(stale.count, 'lead está parado', 'leads estão parados')}</b> há mais de {stale.hours}{' '}
            horas na fila de atendentes.
          </span>
          <button type="button" className="btn btn-line btn-sm" onClick={() => setConfirmStale(true)}>
            Devolver à fila livre
          </button>
        </div>
      )}

      {manager ? (
        <div className="kpis kpis-6">
          <div className="kpi">
            <p className="kpi-l">Leads na base</p>
            <p className="kpi-v">{fmtN(t.leads)}</p>
            <p className="kpi-s">{plural(t.listas, 'lista ativa', 'listas ativas')}</p>
          </div>
          <div className="kpi">
            <p className="kpi-l">Já chamados</p>
            <p className="kpi-v">{fmtN(t.chamados)}</p>
            <p className="kpi-s">
              <b>{t.leads ? Math.round((t.chamados / t.leads) * 100) : 0}%</b> da base
            </p>
          </div>
          <div className="kpi">
            <p className="kpi-l">Chamados hoje</p>
            <p className="kpi-v">{fmtN(t.hoje)}</p>
            <p className="kpi-s">pela equipe toda</p>
          </div>
          <div className="kpi">
            <p className="kpi-l">Faltam chamar</p>
            <p className="kpi-v">{fmtN(pending)}</p>
            <p className="kpi-s">
              <span className="dot ok" />
              Livres <b>{fmtN(t.livres)}</b>
              <span className="dot warn" />
              Na fila <b>{fmtN(t.comAtendentes)}</b>
            </p>
          </div>
          <div className="kpi">
            <p className="kpi-l">Sem WhatsApp</p>
            <p className="kpi-v">{fmtN(t.semWhatsapp)}</p>
            <p className="kpi-s">
              <span className="dot bad" />
              Não contatar <b>{fmtN(t.bloqueados)}</b>
            </p>
          </div>
          <div className="kpi">
            <p className="kpi-l">Fecharam</p>
            <p className="kpi-v">{fmtN(fechados)}</p>
            <p className="kpi-s">
              <span className="dot ok" />
              Interessados <b>{fmtN(interessados)}</b>
            </p>
          </div>
        </div>
      ) : (
        <div className="kpis">
          <div className="kpi">
            <p className="kpi-l">Hoje</p>
            <p className="kpi-v">{fmtN(me?.hoje)}</p>
            <p className="kpi-s">chamados</p>
          </div>
          <div className="kpi">
            <p className="kpi-l">7 dias</p>
            <p className="kpi-v">{fmtN(me?.d7)}</p>
            <p className="kpi-s">
              30 dias <b>{fmtN(me?.d30)}</b>
            </p>
          </div>
          <div className="kpi">
            <p className="kpi-l">Interessados</p>
            <p className="kpi-v">{fmtN(me?.interessados)}</p>
            <p className="kpi-s">
              <span className="dot ok" />
              Fecharam <b>{fmtN(me?.fechados)}</b>
            </p>
          </div>
          <div className="kpi">
            <p className="kpi-l">Conversão</p>
            <p className="kpi-v">{fmtPct(me?.conversao)}</p>
            <p className="kpi-s">fechados ÷ chamados</p>
          </div>
        </div>
      )}

      {perAttendant.length > 0 && (
        <section>
          <div className="section-head">
            <h2>{manager ? 'Por atendente' : 'Seus números'}</h2>
            <p className="sub">
              Chamados de hoje e dos últimos 14 dias. "Sem WhatsApp" não conta como chamado.
            </p>
          </div>
          <div className="acards">
            {perAttendant.map((a) => (
              <AttendantCard
                key={a.user.id}
                a={a}
                highlight={manager && topToday > 0 && a.hoje === topToday}
              />
            ))}
          </div>
        </section>
      )}

      <div className="cfg-grid">
        <section className="panel">
          <h2>Chamados por dia</h2>
          <p className="sub">Últimos 14 dias</p>
          <DailyChart daily={daily} />
        </section>
        <section className="panel">
          <h2>Resultados dos contatos</h2>
          <p className="sub">{plural(totalResults, 'contato registrado', 'contatos registrados')}</p>
          <dl className="soft-box mt16">
            {results.map((r) => {
              const info = resultInfo(r.result);
              return (
                <div key={r.result}>
                  <dt>
                    <span className={`dot t-${info.tone}`} />
                    {info.label}
                  </dt>
                  <dd>
                    {fmtN(r.count)}
                    {totalResults > 0 && (
                      <span className="sub"> · {Math.round((r.count / totalResults) * 100)}%</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      </div>

      {manager && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Andamento da base</h2>
              <p className="sub">
                {fmtN(reached)} de {fmtN(t.leads)} já tiveram tentativa de contato.
              </p>
            </div>
          </div>
          <div
            className="meter"
            role="img"
            aria-label={`${fmtN(t.chamados)} chamados, ${fmtN(t.semWhatsapp)} sem WhatsApp, ${fmtN(t.comAtendentes)} com atendentes, ${fmtN(t.livres)} livres`}
          >
            <i className="m-done" style={{ width: pct(t.chamados, t.leads) }} />
            <i className="m-bad" style={{ width: pct(t.semWhatsapp, t.leads) }} />
            <i className="m-held" style={{ width: pct(t.comAtendentes, t.leads) }} />
          </div>
          <div className="legend">
            <span>
              <i />
              Chamados · {fmtN(t.chamados)}
            </span>
            <span>
              <i className="b" />
              Sem WhatsApp · {fmtN(t.semWhatsapp)}
            </span>
            <span>
              <i className="h" />
              Na fila de um atendente · {fmtN(t.comAtendentes)}
            </span>
            <span>
              <i className="f" />
              Livres · {fmtN(t.livres)}
            </span>
            {t.bloqueados > 0 && <span>Não contatar · {fmtN(t.bloqueados)}</span>}
          </div>
          {lists.length > 0 && (
            <div className="tbl-wrap mt16">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Lista</th>
                    <th>Empresas</th>
                    <th>Faltam pegar</th>
                    <th>Leads</th>
                    <th>Chamados</th>
                    <th>Sem WhatsApp</th>
                    <th>Com atendentes</th>
                    <th>Livres</th>
                    <th style={{ width: '22%' }}>Andamento</th>
                  </tr>
                </thead>
                <tbody>
                  {lists.map((l) => {
                    const done = l.chamados + l.semWhatsapp;
                    const p = l.total ? (done / l.total) * 100 : 0;
                    return (
                      <tr key={l.id}>
                        <td>
                          <b style={{ fontWeight: 600 }}>{l.name}</b>
                        </td>
                        <td>{fmtN(l.empresas)}</td>
                        <td>{fmtN(l.empresasLivres)}</td>
                        <td>{fmtN(l.total)}</td>
                        <td>{fmtN(l.chamados)}</td>
                        <td>{fmtN(l.semWhatsapp)}</td>
                        <td>{fmtN(l.comAtendentes)}</td>
                        <td>{fmtN(l.livres)}</td>
                        <td>
                          <div className="row" style={{ flexWrap: 'nowrap' }}>
                            <div className="progress grow" title={`${Math.round(p)}%`}>
                              <i style={{ width: `${p.toFixed(1)}%` }} />
                            </div>
                            <span className="sub small">{Math.round(p)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <Confirm
        open={confirmStale}
        title="Devolver leads parados?"
        confirmLabel="Devolver à fila livre"
        busy={busy}
        onClose={() => setConfirmStale(false)}
        onConfirm={releaseStale}
      >
        <p>
          {plural(stale.count, 'lead que está', 'leads que estão')} há mais de {stale.hours} horas na fila de
          algum atendente, sem ser chamado, volta para a fila livre. Qualquer atendente poderá pegar.
        </p>
      </Confirm>
    </div>
  );
}
