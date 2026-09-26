import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AutomationRunItem, CampaignDetail, CampaignItem } from '../../../shared/api';
import type { AutomationStatus } from '../../../shared/automations';
import { formatDays } from '../../../shared/campaign-plan';
import { errorMessage } from '../../lib/api';
import {
  automationsApi,
  CAMPAIGN_STATUS_INFO,
  campaignBadge,
  campaignCalendarKey,
  campaignEndLabel,
  campaignKey,
  campaignRunsKey,
  campaignStatsKey,
  campaignsKey,
  RUN_STATUS_INFO,
  runReasonLabel,
  useCampaignRealtime,
  useInvalidateCampaign,
} from '../../lib/automations';
import { describeFilters } from '../../lib/campaign-form';
import { fmtN, fmtWhen, fmtYmd, plural } from '../../lib/format';
import { LIMIT_REACHED_LABEL, usageBreakdown } from '../../lib/quota';
import { IconPause, IconPlay, IconPlus, IconSend } from '../Icons';
import { QuotaMeter } from '../QuotaMeter';
import { useToast } from '../Toasts';
import { Confirm, Empty } from '../ui';
import { CampaignCalendar } from './CampaignCalendar';
import { CampaignDialog, type CampaignSaved } from './CampaignDialog';

const SAVED_TOASTS: Record<CampaignSaved, string> = {
  started: 'Campanha iniciada. Os leads entram aos poucos, dentro do horário de trabalho.',
  scheduled: 'Campanha agendada. Nada é enviado antes da data de início.',
  updated: 'Campanha atualizada. A mudança vale para os próximos leads.',
};

/**
 * Campanha da automação: configurar, iniciar ou agendar, acompanhar, editar, pausar, retomar e encerrar. Só comanda e
 * mostra: quem escolhe o lead, o número e o horário e quem envia é o servidor (job do scheduler + executor). A tela se
 * atualiza pelo tempo real (avisos do servidor, só com ids) e, por garantia, refaz as consultas devagar.
 */
export function CampaignPanel({
  automationId,
  automationName,
  automationStatus,
}: {
  automationId: number;
  automationName: string;
  automationStatus: AutomationStatus;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const invalidate = useInvalidateCampaign(automationId);
  const { pollMs } = useCampaignRealtime(automationId);
  const [starting, setStarting] = useState(false);
  const list = useQuery({
    queryKey: campaignsKey(automationId),
    queryFn: () => automationsApi.campaigns(automationId),
    refetchInterval: pollMs,
  });
  const campaigns = list.data ?? [];
  const live = campaigns.find((c) => c.status === 'active' || c.status === 'paused');
  const last = live ? undefined : campaigns[0];
  const archived = automationStatus === 'archived';

  return (
    <section className="auto-camp" aria-label="Campanha">
      <div className="auto-steps-head">
        <h2>Campanha</h2>
        {!live && !archived && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={automationStatus !== 'active'}
            title={automationStatus === 'active' ? undefined : 'Ative a automação para iniciar uma campanha.'}
            onClick={() => setStarting(true)}
          >
            <IconPlus /> Nova campanha
          </button>
        )}
      </div>

      {list.isError && (
        <p className="banner bad" role="alert">
          {errorMessage(list.error)}
        </p>
      )}

      {live ? (
        <LiveCampaign
          automationId={automationId}
          automationName={automationName}
          item={live}
          automationStatus={automationStatus}
          pollMs={pollMs}
        />
      ) : (
        <>
          {!list.isLoading && (
            <Empty title="Nenhuma campanha em andamento" icon={<IconSend />}>
              <p className="sub">
                {automationStatus === 'active'
                  ? 'Escolha uma lista e os números: inicie agora ou agende. O sistema entra sozinho nos leads, dentro do horário de trabalho.'
                  : 'Ative a automação para poder iniciar uma campanha.'}
              </p>
            </Empty>
          )}
          {last && <EndedSummary automationId={automationId} item={last} />}
        </>
      )}

      {starting && (
        <CampaignDialog
          automationId={automationId}
          automationName={automationName}
          onClose={() => setStarting(false)}
          onDone={(campaign, kind) => {
            qc.setQueryData(campaignKey(automationId, campaign.id), campaign);
            invalidate();
            setStarting(false);
            toast(SAVED_TOASTS[kind]);
          }}
        />
      )}
    </section>
  );
}

function EndedSummary({ automationId, item }: { automationId: number; item: CampaignItem }) {
  const status = CAMPAIGN_STATUS_INFO[item.status];
  const reason = campaignEndLabel(item.endReason);
  return (
    <div className="auto-camp-last">
      <div className="row">
        <b>Última campanha</b>
        <span className={`pill t-${status.tone}`}>{status.label}</span>
        <span className="sub">{item.list ? item.list.name : 'lista removida'}</span>
        {item.endedAt && <span className="sub">terminou {fmtWhen(item.endedAt)}</span>}
      </div>
      {reason && <p className="sub">{reason}.</p>}
      <p className="sub">
        {plural(item.counts.total, 'lead entrou', 'leads entraram')} ·{' '}
        {plural(item.counts.completed, 'concluído', 'concluídos')} ·{' '}
        {plural(item.counts.cancelled, 'cancelado', 'cancelados')} ·{' '}
        {plural(item.counts.failed, 'com falha', 'com falha')}
      </p>
      <CampaignRuns automationId={automationId} campaignId={item.id} pollMs={false} />
    </div>
  );
}

function LiveCampaign({
  automationId,
  automationName,
  item,
  automationStatus,
  pollMs,
}: {
  automationId: number;
  automationName: string;
  item: CampaignItem;
  automationStatus: AutomationStatus;
  pollMs: number;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const invalidate = useInvalidateCampaign(automationId);
  const [stopping, setStopping] = useState(false);
  const [editing, setEditing] = useState(false);
  const detail = useQuery({
    queryKey: campaignKey(automationId, item.id),
    queryFn: () => automationsApi.campaign(automationId, item.id),
    refetchInterval: pollMs,
  });
  const stats = useQuery({
    queryKey: campaignStatsKey(automationId, item.id),
    queryFn: () => automationsApi.campaignStats(automationId, item.id),
    refetchInterval: pollMs,
  });
  const calendar = useQuery({
    queryKey: campaignCalendarKey(automationId, item.id),
    queryFn: () => automationsApi.campaignCalendar(automationId, item.id, 14),
    refetchInterval: pollMs * 2,
  });
  const c: CampaignDetail | CampaignItem = detail.data ?? item;
  const extra = detail.data;
  const badge = campaignBadge(c);
  const filters = describeFilters(c.filters);
  const s = stats.data;
  // O motivo da agenda (agendada, fora do horário, pausada) já aparece no aviso acima: aqui ficam só os outros motivos.
  const reasons = (s?.explain ?? []).filter((line) => line !== c.schedule.reason);

  const change = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'stop') =>
      action === 'pause'
        ? automationsApi.pauseCampaign(automationId, item.id)
        : action === 'resume'
          ? automationsApi.resumeCampaign(automationId, item.id)
          : automationsApi.stopCampaign(automationId, item.id),
    onSuccess: (campaign, action) => {
      qc.setQueryData(campaignKey(automationId, item.id), campaign);
      invalidate();
      setStopping(false);
      toast(
        action === 'pause'
          ? 'Campanha pausada.'
          : action === 'resume'
            ? 'Campanha retomada.'
            : 'Campanha encerrada. O histórico foi mantido.',
      );
    },
    onError: (e) => {
      setStopping(false);
      toast(errorMessage(e), { tone: 'bad' });
      invalidate();
    },
  });

  return (
    <div className="auto-camp-live" data-testid="campanha-viva">
      <div className="auto-camp-top">
        <div className="row">
          <span className={`pill t-${badge.tone}`} data-testid="campanha-status">
            {badge.label}
          </span>
          <b>{c.list ? c.list.name : 'Lista removida'}</b>
        </div>
        <div className="auto-head-actions">
          <button
            type="button"
            className="btn btn-line"
            disabled={change.isPending}
            onClick={() => setEditing(true)}
            data-testid="editar-campanha"
          >
            Editar
          </button>
          {c.status === 'active' ? (
            <button
              type="button"
              className="btn btn-line"
              disabled={change.isPending}
              onClick={() => change.mutate('pause')}
            >
              <IconPause size={16} /> Pausar
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={change.isPending}
              onClick={() => change.mutate('resume')}
            >
              <IconPlay size={16} /> Retomar
            </button>
          )}
          <button
            type="button"
            className="btn btn-line auto-del"
            disabled={change.isPending}
            onClick={() => setStopping(true)}
          >
            Encerrar
          </button>
        </div>
      </div>

      <dl className="camp-facts" aria-label="Configuração da campanha">
        <div>
          <dt>Início</dt>
          <dd data-testid="campanha-inicio">{fmtYmd(c.startDate)}</dd>
        </div>
        <div>
          <dt>Fim</dt>
          <dd data-testid="campanha-fim">{c.endDate ? fmtYmd(c.endDate) : 'Sem data final'}</dd>
        </div>
        <div>
          <dt>Dias</dt>
          <dd data-testid="campanha-dias">{formatDays(c.daysOfWeek)}</dd>
        </div>
        <div>
          <dt>Horário (São Paulo)</dt>
          <dd>
            {c.windowStart} às {c.windowEnd}
          </dd>
        </div>
        <div>
          <dt>Por número, por dia</dt>
          <dd>{plural(c.dailyLimitPerNumber, 'contato', 'contatos')}</dd>
        </div>
        <div>
          <dt>Cooldown</dt>
          <dd>{c.cooldownHours > 0 ? plural(c.cooldownHours, 'hora', 'horas') : 'Sem cooldown'}</dd>
        </div>
      </dl>
      <p className="sub">
        {filters.length
          ? `Filtros: ${filters.join(' · ')}`
          : 'Sem filtros (regra padrão: fila livre, com celular)'}{' '}
        · iniciada {fmtWhen(c.startedAt)}
        {c.startedBy ? ` por ${c.startedBy.name}` : ''}
      </p>

      {c.schedule.state === 'scheduled' && (
        <p className="banner" role="status" data-testid="campanha-agendada">
          {c.schedule.reason}
          {c.schedule.nextOpening ? ` Primeira janela: ${fmtWhen(c.schedule.nextOpening)}.` : ''}
        </p>
      )}
      {c.status === 'active' && c.schedule.state === 'waiting' && c.schedule.reason && (
        <p className="banner" role="status" data-testid="campanha-espera">
          {c.schedule.reason}
          {c.schedule.nextOpening ? ` Próxima janela: ${fmtWhen(c.schedule.nextOpening)}.` : ''}
        </p>
      )}
      {automationStatus !== 'active' && (
        <p className="banner" role="status">
          A automação está pausada: a campanha espera e nada é enviado até ela ser ativada de novo.
        </p>
      )}
      {c.status === 'paused' && (
        <p className="banner" role="status">
          Campanha pausada: nenhum lead novo entra e nada é enviado; a agenda e o histórico continuam
          guardados. Ao retomar, o que venceu nesse tempo sai aos poucos, não de uma vez.
        </p>
      )}

      <dl className="auto-preview-grid camp-counters" aria-label="Andamento da campanha">
        <Counter
          label="Elegíveis"
          value={s?.audience.eligible ?? extra?.eligibleLeads}
          id="campanha-restantes"
        />
        <Counter label="Processados" value={s?.processed ?? c.counts.total} id="campanha-total" />
        <Counter label="Aguardando" value={s?.waiting ?? c.counts.waiting} id="campanha-aguardando" />
        <Counter label="Concluídos" value={s?.completed ?? c.counts.completed} id="campanha-concluidos" />
        <Counter label="Cancelados" value={s?.cancelled ?? c.counts.cancelled} id="campanha-cancelados" />
        <Counter label="Falharam" value={s?.failed ?? c.counts.failed} id="campanha-falharam" />
        <Counter label="Sem WhatsApp" value={s?.noWhatsapp} id="campanha-sem-whatsapp" />
        <Counter label="Bloqueados" value={s?.blocked} id="campanha-bloqueados" />
        <Counter label="Em cooldown" value={s?.audience.inCooldown} id="campanha-cooldown" />
        <Counter label="Sem cota hoje" value={s?.numbersFull} id="campanha-sem-cota" />
        <Counter label="Número desconectado" value={s?.numbersDisconnected} id="campanha-desconectados" />
      </dl>

      {reasons.length > 0 && (
        <div className="camp-explain" data-testid="campanha-explicacao">
          <h3 className="auto-camp-sub">O que a campanha está esperando</h3>
          <ul>
            {reasons.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {extra && (
        <>
          <h3 className="auto-camp-sub">
            Números{' '}
            <span className="sub" data-testid="campanha-disponivel">
              · {plural(extra.availableToday, 'contato novo disponível', 'contatos novos disponíveis')} hoje
              (capacidade de {plural(extra.dailyCapacity, 'lead', 'leads')} por dia)
            </span>
          </h3>
          <ul className="auto-camp-numbers">
            {extra.numbers.map((n) => (
              <li key={n.id} className="auto-camp-number" data-testid={`campanha-numero-${n.id}`}>
                <div className="auto-camp-number-top">
                  <b>{n.label}</b>
                  <span className={`pill t-${n.connected ? 'ok' : 'mute'}`}>
                    {n.connected ? 'Conectado' : 'Desconectado · fora do rodízio'}
                  </span>
                </div>
                <QuotaMeter total={n.usedToday} limit={n.dailyLimit} label={`Uso de hoje: ${n.label}`} />
                <span className="sub" data-testid={`campanha-detalhe-${n.id}`}>
                  {usageBreakdown({
                    manual: n.manualToday,
                    automatic: n.automaticToday,
                    uncertain: n.uncertainToday,
                  })}
                </span>
                <span className="sub" data-testid={`campanha-uso-${n.id}`}>
                  Total: {n.usedToday}/{n.dailyLimit} hoje
                </span>
                {n.limitReached && (
                  <b className="quota-full" data-testid={`campanha-limite-${n.id}`}>
                    {LIMIT_REACHED_LABEL} · indisponível para novos contatos até amanhã
                  </b>
                )}
              </li>
            ))}
          </ul>

          <h3 className="auto-camp-sub">Próximos envios</h3>
          {extra.nextSends.length === 0 ? (
            <p className="sub">Nenhum envio agendado neste momento.</p>
          ) : (
            <ul className="auto-camp-next" data-testid="proximos-envios">
              {extra.nextSends.map((send) => (
                <li key={send.runId}>
                  <b>{fmtWhen(send.at)}</b>
                  <span>{send.lead.label}</span>
                  <span className="sub">{send.instance.label}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {calendar.data && (
        <>
          <h3 className="auto-camp-sub">Calendário de capacidade</h3>
          <CampaignCalendar days={calendar.data.days} estimate={calendar.data.estimate} />
        </>
      )}

      <CampaignRuns automationId={automationId} campaignId={item.id} pollMs={pollMs} />

      {editing && (
        <CampaignDialog
          automationId={automationId}
          automationName={automationName}
          campaign={detail.data}
          onClose={() => setEditing(false)}
          onDone={(campaign, kind) => {
            qc.setQueryData(campaignKey(automationId, item.id), campaign);
            invalidate();
            setEditing(false);
            toast(SAVED_TOASTS[kind]);
          }}
        />
      )}

      <Confirm
        open={stopping}
        title="Encerrar campanha?"
        confirmLabel="Encerrar campanha"
        danger
        busy={change.isPending}
        onConfirm={() => change.mutate('stop')}
        onClose={() => setStopping(false)}
      >
        <p>
          A campanha para de vez e não volta. Os envios que ainda não saíram são cancelados, inclusive as
          etapas seguintes de quem já recebeu a primeira mensagem. Tudo o que já foi enviado continua no
          histórico.
        </p>
      </Confirm>
    </div>
  );
}

function Counter({ label, value, id }: { label: string; value: number | undefined; id: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-testid={id}>{value === undefined ? '—' : fmtN(value)}</dd>
    </div>
  );
}

/** Histórico por execução: lead, empresa, número, áudio, data, hora, etapa, situação e motivo. Cartões (celular e computador). */
function CampaignRuns({
  automationId,
  campaignId,
  pollMs,
}: {
  automationId: number;
  campaignId: number;
  pollMs: number | false;
}) {
  const runs = useQuery({
    queryKey: campaignRunsKey(automationId, campaignId),
    queryFn: () => automationsApi.runs(automationId, 50, campaignId),
    refetchInterval: pollMs,
  });
  const items = runs.data ?? [];
  if (runs.isError) {
    return (
      <p className="banner bad" role="alert">
        {errorMessage(runs.error)}
      </p>
    );
  }
  if (items.length === 0) return null;
  return (
    <>
      <h3 className="auto-camp-sub">Histórico da campanha</h3>
      <ul className="auto-camp-runs" data-testid="campanha-execucoes">
        {items.map((run) => (
          <CampaignRunRow key={run.id} run={run} />
        ))}
      </ul>
    </>
  );
}

function CampaignRunRow({ run }: { run: AutomationRunItem }) {
  const status = RUN_STATUS_INFO[run.status];
  const reason = runReasonLabel(run.reason);
  const sent = run.steps.find((s) => s.status === 'completed');
  const audio = run.steps.find((s) => s.audio)?.audio;
  const lead = run.lead;
  return (
    <li className="auto-camp-run">
      <div className="auto-run-top">
        <b>{lead?.company ?? lead?.label ?? 'Lead excluído'}</b>
        <span className={`pill t-${status.tone}`}>{status.label}</span>
      </div>
      {lead?.company && lead.name && <span className="sub small">{lead.name}</span>}
      <dl className="auto-camp-run-grid">
        <div>
          <dt>Número</dt>
          <dd>{run.instance?.label ?? '—'}</dd>
        </div>
        <div>
          <dt>Áudio</dt>
          <dd>{audio?.label ?? '—'}</dd>
        </div>
        <div>
          <dt>{sent?.finishedAt ? 'Enviado' : 'Agendado'}</dt>
          <dd>{fmtWhen(sent?.finishedAt ?? run.nextRunAt) || '—'}</dd>
        </div>
        <div>
          <dt>Etapa</dt>
          <dd>{run.currentStep}</dd>
        </div>
      </dl>
      {reason && <span className={run.status === 'failed' ? 'auto-run-bad' : 'sub small'}>{reason}</span>}
    </li>
  );
}
