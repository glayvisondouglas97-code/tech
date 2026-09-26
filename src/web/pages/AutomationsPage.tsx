import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { type AutoCampaignCounts, type AutoCampaignState, replyRate } from '../../shared/auto-campaign';
import { IconPause, IconPlay } from '../components/Icons';
import { QuotaMeter } from '../components/QuotaMeter';
import { useToast } from '../components/Toasts';
import { errorMessage } from '../lib/api';
import { AUTO_CAMPAIGN_KEY, autoCampaignApi, useAutoCampaign } from '../lib/auto-campaign';
import { fmtN, fmtWhen, plural } from '../lib/format';

/**
 * Automações = a campanha automática, pré-definida pelo sistema. Aqui só se ativa ou pausa e se acompanha as métricas.
 * Quem escolhe o lead, sorteia o áudio e o número e envia é o servidor, só em dias úteis das 10:00 às 16:00.
 */
export function AutomationsPage() {
  const query = useAutoCampaign();
  const s = query.data;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Automações</h1>
          <p className="sub">
            Campanha automática: envia um áudio sorteado da biblioteca para os leads da fila livre, por um
            número sorteado entre os conectados.
          </p>
        </div>
      </div>

      {query.isLoading ? (
        <div className="num-loading">
          <span className="spinner" />
        </div>
      ) : query.isError || !s ? (
        <div className="banner bad ac-error" role="alert">
          <span>{errorMessage(query.error)}</span>
          <button type="button" className="btn btn-line btn-sm" onClick={() => void query.refetch()}>
            Tentar de novo
          </button>
        </div>
      ) : (
        <>
          <ActivationCard state={s} />
          {s.warnings.length > 0 && (
            <ul className="ac-warnings">
              {s.warnings.map((w) => (
                <li key={w} className="banner" role="status">
                  {w}
                </li>
              ))}
            </ul>
          )}
          <Metrics state={s} />
          <Numbers state={s} />
        </>
      )}
    </>
  );
}

const STATUS_TONE: Record<AutoCampaignState['status'], string> = {
  off: 't-mute',
  paused: 't-warn',
  active: 't-ok',
};
const STATUS_LABEL: Record<AutoCampaignState['status'], string> = {
  off: 'Desativada',
  paused: 'Pausada',
  active: 'Ativa',
};

function ActivationCard({ state }: { state: AutoCampaignState }) {
  const qc = useQueryClient();
  const toast = useToast();
  const active = state.status === 'active';
  const toggle = useMutation({
    mutationFn: () => (active ? autoCampaignApi.pause() : autoCampaignApi.activate()),
    onSuccess: (next) => {
      qc.setQueryData(AUTO_CAMPAIGN_KEY, next);
      toast(next.status === 'active' ? 'Campanha automática ativada.' : 'Campanha automática pausada.');
    },
    onError: (e) => toast(errorMessage(e), { tone: 'bad' }),
  });
  const { rules } = state;
  const title =
    state.status === 'off'
      ? 'Pronta para ativar'
      : state.status === 'paused'
        ? 'Nada é enviado até você ativar de novo'
        : capitalize(state.headline.split(' · ')[1] ?? state.headline);

  return (
    <section className={`ac-card${active ? ' on' : ''}`} aria-label="Campanha automática">
      <div className="ac-card-main">
        <span className={`pill ${STATUS_TONE[state.status]}`}>{STATUS_LABEL[state.status]}</span>
        <h2 className="ac-headline">{title}</h2>
        <p className="ac-rules">
          {rules.days} · das {rules.windowStart} às {rules.windowEnd} · até {rules.dailyLimitPerNumber}{' '}
          contatos por número por dia
        </p>
        {state.activatedAt && state.status !== 'off' && (
          <p className="ac-by">
            Ativada {fmtWhen(state.activatedAt)}
            {state.activatedBy ? ` por ${state.activatedBy}` : ''}
          </p>
        )}
      </div>
      <button
        type="button"
        className={`btn ${active ? 'btn-line' : 'btn-primary'} ac-toggle`}
        onClick={() => toggle.mutate()}
        disabled={toggle.isPending}
        aria-busy={toggle.isPending}
      >
        {active ? <IconPause /> : <IconPlay />}
        {active ? 'Pausar' : state.status === 'paused' ? 'Ativar de novo' : 'Ativar'}
      </button>
    </section>
  );
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function Metrics({ state }: { state: AutoCampaignState }) {
  const m = state.metrics;
  return (
    <section className="ac-metrics" aria-label="Métricas">
      <div className="kpi ac-today">
        <p className="kpi-l">Para enviar hoje</p>
        <p className="kpi-v">{fmtN(m.toSendToday)}</p>
        <p className="kpi-s">
          <b>{fmtN(m.available)}</b> {m.available === 1 ? 'lead disponível' : 'leads disponíveis'} ·{' '}
          {todayNote(state)}
        </p>
      </div>
      <div className="kpis ac-kpis">
        <Kpi label="Enviados" today={m.today.sent} total={m.total.sent} />
        <Kpi label="Sem WhatsApp" today={m.today.noWhatsapp} total={m.total.noWhatsapp} />
        <Kpi label="Responderam" today={m.today.replied} total={m.total.replied} extra={rate(m.total)} />
        <Kpi label="Não responderam" today={m.today.notReplied} total={m.total.notReplied} />
      </div>
      <p className="ac-foot">
        "Hoje" conta os leads que receberam o áudio hoje. "Total" conta desde a primeira ativação.
      </p>
    </section>
  );
}

/** Por que o "para enviar hoje" é o que é: vagas de hoje, ou o motivo de não haver envio hoje. */
function todayNote(state: AutoCampaignState) {
  const { rules, metrics } = state;
  if (state.status !== 'active') return 'ative a campanha para enviar';
  if (state.phase === 'not_a_run_day') return `hoje não é dia de envio (${rules.days})`;
  if (state.phase === 'after_window')
    return `o horário de hoje já acabou (${rules.windowStart} às ${rules.windowEnd})`;
  return (
    <>
      <b>{fmtN(metrics.capacityToday)}</b> {metrics.capacityToday === 1 ? 'vaga' : 'vagas'} hoje nos números
    </>
  );
}

const rate = (c: AutoCampaignCounts) => (c.sent > 0 ? `${replyRate(c)}% de resposta` : null);

function Kpi({
  label,
  today,
  total,
  extra,
}: {
  label: string;
  today: number;
  total: number;
  extra?: string | null;
}) {
  return (
    <div className="kpi">
      <p className="kpi-l">{label}</p>
      <p className="kpi-v">
        {fmtN(today)} <small>hoje</small>
      </p>
      <p className="kpi-s">
        Total: <b>{fmtN(total)}</b>
        {extra ? ` · ${extra}` : ''}
      </p>
    </div>
  );
}

function Numbers({ state }: { state: AutoCampaignState }) {
  const connected = state.numbers.filter((n) => n.connected).length;
  return (
    <section className="ac-numbers" aria-label="Números">
      <div className="ac-numbers-head">
        <h2>Números</h2>
        <p className="sub">
          {plural(connected, 'conectado', 'conectados')} de {state.numbers.length} · contatos novos de hoje
        </p>
      </div>
      {state.numbers.length === 0 ? (
        <p className="sub">
          Nenhum número cadastrado. <Link to="/numeros">Cadastrar um número</Link>
        </p>
      ) : (
        <ul className="ac-number-list">
          {state.numbers.map((n) => (
            <li key={n.id} className={n.connected ? '' : 'off'}>
              <span className="ac-number-name">
                <span className={`dot ${n.connected ? 'ok' : 'bad'}`} aria-hidden="true" />
                <b title={n.label}>{n.label}</b>
                {!n.connected && <small>desconectado</small>}
              </span>
              <QuotaMeter total={n.usedToday} limit={n.limit} label={`Contatos de hoje de ${n.label}`} />
              <span className="ac-number-count">
                {n.usedToday}/{n.limit}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="ac-foot">
        Áudios no sorteio: <b>{state.activeAudios}</b> · <Link to="/audios">Gerenciar áudios</Link>
      </p>
    </section>
  );
}
