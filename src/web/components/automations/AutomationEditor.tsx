import { useMutation, useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import type { AutomationStep, ListSummary } from '../../../shared/api';
import { AUTOMATION_MAX_STEPS, automationProblems, stepProblem } from '../../../shared/automations';
import { api, errorMessage } from '../../lib/api';
import {
  ACTION_LABELS,
  AUDIOS_QUERY_KEY,
  automationsApi,
  describeCondition,
  formatDelay,
  STATUS_INFO,
  TRIGGER_HELP,
  TRIGGER_LABELS,
  useAutomation,
  useAutomationCache,
} from '../../lib/automations';
import { plural } from '../../lib/format';
import { audioMediaUrl, formatDuration, formatSize, wa } from '../../lib/whatsapp';
import {
  IconBack,
  IconChevron,
  IconClock,
  IconConversas,
  IconDots,
  IconMic,
  IconPencil,
  IconPlus,
  IconTrash,
} from '../Icons';
import { useToast } from '../Toasts';
import { Confirm, Empty, Menu } from '../ui';
import { AutomationDialog } from './AutomationDialog';
import { CampaignPanel } from './CampaignPanel';
import { RunsPanel } from './RunsPanel';
import { StepDialog } from './StepDialog';

/**
 * Editor de uma automação: dados, situação (ativar/pausar) e as etapas em ordem.
 * Só configura. Mesmo ativa, a automação não envia nada: o executor vem numa próxima etapa.
 */
export function AutomationEditor({ id }: { id: number }) {
  const toast = useToast();
  const cache = useAutomationCache();
  const query = useAutomation(id);
  const audios = useQuery({ queryKey: AUDIOS_QUERY_KEY, queryFn: wa.audios, staleTime: 30_000 });
  const lists = useQuery({
    queryKey: ['automation-lists'],
    queryFn: () => api<ListSummary[]>('/lists?archived=0'),
    staleTime: 60_000,
  });
  const [stepDialog, setStepDialog] = useState<AutomationStep | 'new' | null>(null);
  const [removing, setRemoving] = useState<AutomationStep | null>(null);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'paused') => automationsApi.setStatus(id, status),
    onSuccess: (item) => {
      cache.setAutomation(item);
      toast(
        item.status === 'active'
          ? 'Automação ativada. As etapas passam a ser enviadas de verdade, no tempo de cada uma.'
          : 'Automação pausada.',
      );
    },
    onError: (e) => {
      toast(errorMessage(e), { tone: 'bad' });
      void cache.reload(id);
    },
  });
  const archive = useMutation({
    mutationFn: () => automationsApi.archive(id),
    onSuccess: (item) => {
      cache.setAutomation(item);
      setArchiving(false);
      toast('Automação arquivada.');
    },
    onError: (e) => {
      setArchiving(false);
      toast(errorMessage(e), { tone: 'bad' });
      void cache.reload(id);
    },
  });
  const removeStep = useMutation({
    mutationFn: (stepId: number) => automationsApi.deleteStep(id, stepId),
    onSuccess: (steps) => {
      cache.setSteps(id, steps);
      setRemoving(null);
      toast('Etapa excluída.');
    },
    onError: (e) => {
      setRemoving(null);
      toast(errorMessage(e), { tone: 'bad' });
      void cache.reload(id);
    },
  });
  const reorder = useMutation({
    mutationFn: (stepIds: number[]) => automationsApi.reorderSteps(id, stepIds),
    onSuccess: (steps) => cache.setSteps(id, steps),
    onError: (e) => {
      toast(errorMessage(e), { tone: 'bad' });
      void cache.reload(id);
    },
  });

  if (query.isLoading) {
    return (
      <div className="num-loading">
        <span className="spinner" />
      </div>
    );
  }
  const automation = query.data;
  if (!automation) {
    return (
      <>
        <BackLink />
        <Empty title="Automação não encontrada" icon={<IconConversas />}>
          <p className="sub">Ela pode ter sido removida. Volte para a lista e escolha outra.</p>
        </Empty>
      </>
    );
  }

  const steps = automation.steps;
  const archived = automation.status === 'archived';
  const status = STATUS_INFO[automation.status];
  const problems = automationProblems(steps);
  const busy = setStatus.isPending || archive.isPending || removeStep.isPending || reorder.isPending;
  const audiosById = new Map((audios.data ?? []).map((a) => [a.id, a]));
  const activeAudios = (audios.data ?? []).filter((a) => a.active).length;
  const listOptions = (lists.data ?? []).map((l) => ({ id: l.id, name: l.name }));
  const listName = (listId: string) => listOptions.find((l) => l.id === listId)?.name;

  function move(index: number, delta: -1 | 1) {
    const ids = steps.map((s) => s.id);
    const moving = ids[index];
    const other = ids[index + delta];
    if (moving === undefined || other === undefined) return;
    ids[index] = other;
    ids[index + delta] = moving;
    reorder.mutate(ids);
  }

  return (
    <>
      <BackLink />
      <div className="page-head">
        <div>
          <h1>{automation.name}</h1>
          <div className="row">
            <span className={`pill t-${status.tone}`}>{status.label}</span>
            <span className="sub">Gatilho: {TRIGGER_LABELS[automation.trigger]}</span>
          </div>
          <p className="sub auto-desc">{TRIGGER_HELP[automation.trigger]}</p>
          {automation.description && <p className="sub auto-desc">{automation.description}</p>}
        </div>
        {!archived && (
          <div className="auto-head-actions">
            <button type="button" className="btn btn-line" onClick={() => setEditing(true)}>
              <IconPencil size={16} /> Editar dados
            </button>
            {automation.status === 'active' ? (
              <button
                type="button"
                className="btn btn-line"
                disabled={busy}
                onClick={() => setStatus.mutate('paused')}
              >
                Pausar
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || problems.length > 0}
                title={problems[0]}
                onClick={() => setStatus.mutate('active')}
              >
                Ativar
              </button>
            )}
            <Menu label="Mais ações da automação" icon={<IconDots />}>
              <button type="button" role="menuitem" className="danger" onClick={() => setArchiving(true)}>
                <IconTrash /> Arquivar
              </button>
            </Menu>
          </div>
        )}
      </div>

      <p className="banner info auto-note">
        {automation.status === 'active'
          ? 'Esta automação está ativa e envia mensagens de verdade pelo WhatsApp, no tempo de cada etapa. '
          : 'Quando você ativar, esta automação passa a enviar mensagens de verdade pelo WhatsApp, no tempo de cada etapa. '}
        Ela para sozinha se o lead responder, se o telefone entrar em "não contatar" ou se você pausar ou
        arquivar.
      </p>
      {archived && (
        <p className="banner auto-note" role="status">
          Esta automação está arquivada: dá para consultar, mas ela não pode ser editada, ativada nem receber
          novas etapas.
        </p>
      )}
      {!archived && automation.status !== 'active' && problems.length > 0 && (
        <div className="banner auto-note" role="status">
          <div>
            <b>Para ativar:</b>
            <ul className="auto-problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="auto-steps-head">
        <h2>Etapas</h2>
        <span className="sub">{plural(steps.length, 'etapa', 'etapas')}</span>
      </div>

      {steps.length === 0 ? (
        <Empty title="Nenhuma etapa ainda" icon={<IconClock />}>
          <p className="sub">
            {archived
              ? 'Esta automação não tem etapas.'
              : 'Cada etapa espera um tempo e envia uma mensagem de texto ou um áudio.'}
          </p>
          {!archived && (
            <div className="row" style={{ marginTop: 14, justifyContent: 'center' }}>
              <button type="button" className="btn btn-primary" onClick={() => setStepDialog('new')}>
                <IconPlus /> Adicionar etapa
              </button>
            </div>
          )}
        </Empty>
      ) : (
        <ol className="auto-steps" aria-label="Etapas da automação">
          {steps.map((step, index) => {
            const problem = stepProblem(step);
            const audio = step.audioId == null ? undefined : audiosById.get(step.audioId);
            return (
              <Fragment key={step.id}>
                {index > 0 && (
                  <li className="auto-arrow" aria-hidden="true">
                    <IconChevron />
                  </li>
                )}
                <li className={`auto-step${problem ? ' bad' : ''}`} aria-label={`Etapa ${step.position}`}>
                  <span className="auto-step-num" aria-hidden="true">
                    {step.position}
                  </span>
                  <div className="auto-step-body">
                    <span className="auto-step-delay">
                      <IconClock size={14} />
                      {step.delaySeconds === 0
                        ? 'Imediatamente'
                        : `Aguardar ${formatDelay(step.delaySeconds)}`}
                    </span>
                    <h3 className="auto-step-title">
                      {step.actionType === 'send_audio' ? <IconMic size={17} /> : <IconConversas size={17} />}
                      {ACTION_LABELS[step.actionType]}
                    </h3>
                    {step.actionType === 'send_text' ? (
                      step.messageText && <p className="auto-step-text">{step.messageText}</p>
                    ) : step.audioMode === 'random' ? (
                      <div className="auto-step-audio">
                        <span>
                          <b>Sorteia um áudio a cada envio</b>
                          <small>
                            {audios.isSuccess
                              ? `${plural(activeAudios, 'áudio ativo', 'áudios ativos')} na biblioteca · nenhum repete em seguida`
                              : 'Carregando os áudios…'}
                          </small>
                        </span>
                      </div>
                    ) : (
                      <div className="auto-step-audio">
                        {audio ? (
                          <>
                            <span>
                              <b>{audio.label}</b>
                              <small>
                                {audio.seconds ? formatDuration(audio.seconds) : '—'} ·{' '}
                                {formatSize(audio.bytes)}
                              </small>
                            </span>
                            {/* biome-ignore lint/a11y/useMediaCaption: áudio gravado pela equipe, sem legenda */}
                            <audio controls preload="none" src={audioMediaUrl(audio.id)} />
                          </>
                        ) : step.audioId != null && !audios.isSuccess ? (
                          <span className="sub">Carregando o áudio…</span>
                        ) : null}
                      </div>
                    )}
                    {problem && (
                      <span className="tag bad">
                        Etapa incompleta: {problem}
                        {step.actionType === 'send_audio' && step.audioId == null
                          ? ' (o áudio pode ter sido excluído)'
                          : ''}
                      </span>
                    )}
                    {step.conditions.length > 0 && (
                      <div className="auto-step-conds">
                        <span>Só se:</span>
                        {step.conditions.map((c, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: as condições não têm id próprio
                          <span key={i} className="tag">
                            {describeCondition(c, listName)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {!archived && (
                    <div className="auto-step-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Subir a etapa ${step.position}`}
                        title="Subir"
                        disabled={busy || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <IconChevron className="auto-up" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Descer a etapa ${step.position}`}
                        title="Descer"
                        disabled={busy || index === steps.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <IconChevron />
                      </button>
                      <button
                        type="button"
                        className="btn btn-line btn-sm"
                        aria-label={`Editar a etapa ${step.position}`}
                        disabled={busy}
                        onClick={() => setStepDialog(step)}
                      >
                        <IconPencil size={15} /> Editar
                      </button>
                      <button
                        type="button"
                        className="btn btn-line btn-sm auto-del"
                        aria-label={`Excluir a etapa ${step.position}`}
                        disabled={busy}
                        onClick={() => setRemoving(step)}
                      >
                        <IconTrash size={15} /> Excluir
                      </button>
                    </div>
                  )}
                </li>
              </Fragment>
            );
          })}
        </ol>
      )}

      {!archived && steps.length > 0 && (
        <div className="auto-add-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || steps.length >= AUTOMATION_MAX_STEPS}
            onClick={() => setStepDialog('new')}
          >
            <IconPlus /> Adicionar etapa
          </button>
          {steps.length >= AUTOMATION_MAX_STEPS && (
            <span className="sub small">Limite de {AUTOMATION_MAX_STEPS} etapas por automação.</span>
          )}
        </div>
      )}

      <CampaignPanel
        automationId={id}
        automationName={automation.name}
        automationStatus={automation.status}
      />

      <RunsPanel automationId={id} counts={automation.runs} active={automation.status === 'active'} />

      {stepDialog && (
        <StepDialog
          key={stepDialog === 'new' ? 'nova' : stepDialog.id}
          automationId={id}
          step={stepDialog === 'new' ? null : stepDialog}
          first={stepDialog === 'new' ? steps.length === 0 : stepDialog.position === 1}
          lists={listOptions}
          onClose={() => setStepDialog(null)}
          onSaved={(saved) => {
            cache.setSteps(id, saved);
            toast(stepDialog === 'new' ? 'Etapa adicionada.' : 'Etapa salva.');
            setStepDialog(null);
          }}
        />
      )}
      {editing && (
        <AutomationDialog
          automation={automation}
          onClose={() => setEditing(false)}
          onSaved={(item) => {
            cache.setAutomation(item);
            toast('Automação salva.');
            setEditing(false);
          }}
        />
      )}
      <Confirm
        open={!!removing}
        title="Excluir etapa?"
        confirmLabel="Excluir"
        danger
        busy={removeStep.isPending}
        onConfirm={() => removing && removeStep.mutate(removing.id)}
        onClose={() => setRemoving(null)}
      >
        <p>
          A etapa <b>{removing?.position}</b> ({removing && ACTION_LABELS[removing.actionType].toLowerCase()})
          será excluída e as seguintes sobem uma posição.
        </p>
      </Confirm>
      <Confirm
        open={archiving}
        title="Arquivar automação?"
        confirmLabel="Arquivar"
        danger
        busy={archive.isPending}
        onConfirm={() => archive.mutate()}
        onClose={() => setArchiving(false)}
      >
        <p>
          <b>{automation.name}</b> fica só para consulta: não poderá mais ser editada, ativada nem receber
          etapas, e não volta a ficar ativa. Nada é apagado.
        </p>
      </Confirm>
    </>
  );
}

function BackLink() {
  return (
    <Link to="/automacoes" className="btn btn-ghost btn-sm auto-back">
      <IconBack size={16} /> Voltar para as automações
    </Link>
  );
}
