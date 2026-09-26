import { useQuery } from '@tanstack/react-query';
import type { AutomationRunCounts } from '../../../shared/api';
import { errorMessage } from '../../lib/api';
import {
  automationRunsKey,
  automationsApi,
  RUN_STATUS_INFO,
  runReasonLabel,
  STEP_RUN_LABELS,
} from '../../lib/automations';
import { fmtWhen, plural } from '../../lib/format';

/**
 * O que o executor está fazendo: contadores e as participações mais recentes dos leads (só leitura).
 * Numa automação ativa a lista se atualiza sozinha a cada 15 segundos.
 */
export function RunsPanel({
  automationId,
  counts,
  active,
}: {
  automationId: number;
  counts: AutomationRunCounts;
  active: boolean;
}) {
  const runs = useQuery({
    queryKey: automationRunsKey(automationId),
    queryFn: () => automationsApi.runs(automationId),
    refetchInterval: active ? 15_000 : false,
  });
  const inProgress = counts.pending + counts.running;
  const total = inProgress + counts.completed + counts.cancelled + counts.failed;

  return (
    <section className="auto-runs" aria-label="Execuções">
      <div className="auto-steps-head">
        <h2>Execuções</h2>
        <span className="sub">
          {total === 0
            ? 'Nenhum lead entrou nesta automação ainda.'
            : `${plural(inProgress, 'em andamento', 'em andamento')} · ${plural(counts.completed, 'concluída', 'concluídas')} · ${plural(counts.cancelled, 'cancelada', 'canceladas')} · ${plural(counts.failed, 'com falha', 'com falha')}`}
        </span>
      </div>
      {runs.isError && (
        <p className="banner bad" role="alert">
          {errorMessage(runs.error)}
        </p>
      )}
      {(runs.data ?? []).length > 0 && (
        <ul className="auto-run-list">
          {(runs.data ?? []).map((run) => {
            const status = RUN_STATUS_INFO[run.status];
            const reason = runReasonLabel(run.reason);
            return (
              <li key={run.id} className="auto-run">
                <div className="auto-run-top">
                  <b>{run.lead?.label ?? 'Lead excluído'}</b>
                  <span className={`pill t-${status.tone}`}>{status.label}</span>
                </div>
                <div className="auto-run-meta">
                  <span>Etapa {run.currentStep}</span>
                  {run.campaignId !== null && <span>Campanha</span>}
                  {run.instance && <span>Número: {run.instance.label}</span>}
                  {run.status === 'pending' && run.nextRunAt && (
                    <span>Próxima etapa {fmtWhen(run.nextRunAt)}</span>
                  )}
                  {run.completedAt && <span>Concluída {fmtWhen(run.completedAt)}</span>}
                  {run.cancelledAt && <span>Cancelada {fmtWhen(run.cancelledAt)}</span>}
                  {reason && (
                    <span className={run.status === 'failed' ? 'auto-run-bad' : undefined}>{reason}</span>
                  )}
                </div>
                {run.steps.length > 0 && (
                  <div className="auto-run-steps">
                    {run.steps.map((step) => (
                      <span
                        key={`${step.stepId ?? 'x'}-${step.position ?? 'x'}`}
                        className="tag"
                        title={step.error ?? undefined}
                      >
                        Etapa {step.position ?? '?'}: {STEP_RUN_LABELS[step.status]}
                        {step.audio ? ` · áudio ${step.audio.label}` : ''}
                        {step.attempts > 1 ? ` (${step.attempts} tentativas)` : ''}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
