import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useLayoutEffect, useRef, useState } from 'react';
import type { AutomationCondition, AutomationStep, AutomationStepInput } from '../../../shared/api';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_AUDIO_MODES,
  AUTOMATION_MESSAGE_MAX,
  AUTOMATION_VARIABLES,
  type AutomationActionType,
  type AutomationAudioMode,
  stepProblem,
  unknownVariables,
} from '../../../shared/automations';
import { errorMessage } from '../../lib/api';
import {
  ACTION_LABELS,
  AUDIO_MODE_LABELS,
  AUDIOS_QUERY_KEY,
  automationsApi,
  parseDelay,
  splitDelay,
} from '../../lib/automations';
import { audioMediaUrl, formatDuration, formatSize, wa } from '../../lib/whatsapp';
import { Dialog } from '../ui';
import { ConditionsEditor, type ListOption } from './ConditionsEditor';
import { type DelayDraft, DelayField } from './DelayField';

/** Janela para criar ou editar uma etapa. Só configura: salvar não envia nada. */
export function StepDialog({
  automationId,
  step,
  first,
  lists,
  onClose,
  onSaved,
}: {
  automationId: number;
  /** A etapa que está sendo editada; vazio = etapa nova (entra no fim). */
  step: AutomationStep | null;
  /** É (ou será) a primeira etapa: a espera conta a partir do começo da automação. */
  first: boolean;
  lists: ListOption[];
  onClose: () => void;
  onSaved: (steps: AutomationStep[]) => void;
}) {
  const audios = useQuery({ queryKey: AUDIOS_QUERY_KEY, queryFn: wa.audios, staleTime: 30_000 });
  const start = splitDelay(step?.delaySeconds ?? 0);
  const [actionType, setActionType] = useState<AutomationActionType>(step?.actionType ?? 'send_text');
  const [delay, setDelay] = useState<DelayDraft>({ value: String(start.value), unit: start.unit });
  const [text, setText] = useState(step?.messageText ?? '');
  const [audioId, setAudioId] = useState<number | null>(step?.audioId ?? null);
  const [audioMode, setAudioMode] = useState<AutomationAudioMode>(step?.audioMode ?? 'fixed');
  const [conditions, setConditions] = useState<AutomationCondition[]>(step?.conditions ?? []);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Onde o cursor deve ficar depois de inserir uma variável (aplicado assim que o texto novo aparece na tela).
  const [caretAt, setCaretAt] = useState<number | null>(null);

  const save = useMutation({
    mutationFn: (input: AutomationStepInput) =>
      step
        ? automationsApi.updateStep(automationId, step.id, input)
        : automationsApi.createStep(automationId, input),
    onSuccess: onSaved,
    onError: (e) => setError(errorMessage(e)),
  });

  const library = audios.data ?? [];
  const activeCount = library.filter((a) => a.active).length;
  const typos = actionType === 'send_text' ? unknownVariables(text) : [];

  function insertVariable(name: string) {
    const token = `{{${name}}}`;
    const el = textRef.current;
    const from = el?.selectionStart ?? text.length;
    const to = el?.selectionEnd ?? text.length;
    const next = text.slice(0, from) + token + text.slice(to);
    if (next.length > AUTOMATION_MESSAGE_MAX) return;
    setText(next);
    setCaretAt(from + token.length);
  }

  // Sem esperar o próximo quadro: o cursor vai para depois da variável antes de qualquer tecla digitada em seguida.
  useLayoutEffect(() => {
    if (caretAt === null) return;
    const el = textRef.current;
    el?.focus();
    el?.setSelectionRange(caretAt, caretAt);
    setCaretAt(null);
  }, [caretAt]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const delaySeconds = parseDelay(delay.value, delay.unit);
    if (delaySeconds === null) return setError('Informe um tempo de espera válido, de 0 até 1 ano.');
    const messageText = actionType === 'send_text' ? text.trim() || null : null;
    const mode: AutomationAudioMode = actionType === 'send_audio' ? audioMode : 'fixed';
    const chosenAudio = actionType === 'send_audio' && mode === 'fixed' ? audioId : null;
    const problem = stepProblem({ actionType, messageText, audioId: chosenAudio, audioMode: mode });
    if (problem) return setError(`${problem.charAt(0).toUpperCase()}${problem.slice(1)}`);
    if (conditions.some((c) => c.field === 'lead_list' && !c.value)) {
      return setError('Escolha a lista da condição ou remova a condição.');
    }
    save.mutate({ actionType, delaySeconds, messageText, audioId: chosenAudio, audioMode: mode, conditions });
  }

  return (
    <Dialog open onClose={onClose} title={step ? `Editar etapa ${step.position}` : 'Nova etapa'}>
      <form className="stack auto-form" style={{ gap: 16 }} onSubmit={submit} noValidate>
        <label className="field">
          <span>Tipo da ação</span>
          <select
            className="select"
            value={actionType}
            onChange={(e) => setActionType(e.target.value as AutomationActionType)}
          >
            {AUTOMATION_ACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {ACTION_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        <DelayField
          label={first ? 'Tempo depois que a automação começar' : 'Tempo após a etapa anterior'}
          draft={delay}
          onChange={setDelay}
        />

        {actionType === 'send_text' ? (
          <div className="field">
            <label htmlFor="etapa-mensagem">Mensagem</label>
            <textarea
              id="etapa-mensagem"
              ref={textRef}
              className="input auto-text"
              rows={6}
              maxLength={AUTOMATION_MESSAGE_MAX}
              placeholder="Ex.: Olá, {{nome}}! Tudo bem?"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <small className="auto-counter">
              {text.length} / {AUTOMATION_MESSAGE_MAX}
            </small>
            <div className="auto-vars">
              <span className="sub small">Você pode usar:</span>
              {AUTOMATION_VARIABLES.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  className="auto-var"
                  title={v.label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertVariable(v.name)}
                >
                  {`{{${v.name}}}`}
                </button>
              ))}
            </div>
            <small>
              Na hora do envio, cada variável é trocada pelos dados reais do lead. Uma variável que não existe
              faz a etapa falhar: nada é enviado.
            </small>
            {typos.length > 0 && (
              <small className="error-text" role="status">
                Variável que não existe: {typos.map((t) => `{{${t}}}`).join(', ')}. Confira a escrita.
              </small>
            )}
          </div>
        ) : (
          <fieldset className="field auto-audio-field">
            <legend>Áudio</legend>
            <div className="seg auto-audio-mode" role="radiogroup" aria-label="Como escolher o áudio">
              {AUTOMATION_AUDIO_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={audioMode === mode}
                  onClick={() => setAudioMode(mode)}
                >
                  {AUDIO_MODE_LABELS[mode]}
                </button>
              ))}
            </div>
            {audioMode === 'random' ? (
              <p className={activeCount === 0 ? 'banner bad' : 'note'} role="status">
                {activeCount === 0
                  ? 'Não há nenhum áudio ativo na biblioteca. Ative pelo menos um na tela Áudios.'
                  : `A cada envio, um áudio é sorteado entre os ${activeCount} ativos da biblioteca. Todos saem uma vez antes de qualquer um repetir, e o mesmo áudio nunca sai duas vezes seguidas. O sorteio é guardado no servidor.`}
              </p>
            ) : audios.isLoading ? (
              <span className="spinner" role="status" aria-label="Carregando os áudios" />
            ) : library.length === 0 ? (
              <p className="note">
                Nenhum áudio salvo ainda. Salve um na tela <b>Áudios</b> e volte aqui para escolher.
              </p>
            ) : (
              <ul className="auto-audios">
                {library.map((audio) => (
                  <li key={audio.id} className={`auto-audio${audioId === audio.id ? ' on' : ''}`}>
                    <label>
                      <input
                        type="radio"
                        name="etapa-audio"
                        checked={audioId === audio.id}
                        onChange={() => setAudioId(audio.id)}
                      />
                      <span className="auto-audio-main">
                        <b>{audio.label}</b>
                        <small>
                          {audio.seconds ? formatDuration(audio.seconds) : '—'} · {formatSize(audio.bytes)}
                          {audio.active ? '' : ' · fora do sorteio do Chamar'}
                        </small>
                      </span>
                    </label>
                    {/* biome-ignore lint/a11y/useMediaCaption: áudio gravado pela equipe, sem legenda */}
                    <audio controls preload="none" src={audioMediaUrl(audio.id)} />
                  </li>
                ))}
              </ul>
            )}
            {audioMode === 'fixed' &&
              step?.actionType === 'send_audio' &&
              step.audioId == null &&
              audioId == null && (
                <small className="error-text">
                  O áudio que esta etapa usava foi excluído. Escolha outro.
                </small>
              )}
          </fieldset>
        )}

        <div className="field">
          <span>Condições (opcional)</span>
          <ConditionsEditor conditions={conditions} lists={lists} onChange={setConditions} />
          <small>
            As condições são conferidas antes de cada envio. Se alguma não for atendida, a etapa é pulada
            (nada é enviado) e a automação segue para a próxima.
          </small>
        </div>

        {error && (
          <p className="banner bad" role="alert">
            {error}
          </p>
        )}

        <div className="row end">
          <button type="button" className="btn btn-line" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={save.isPending}
            aria-busy={save.isPending}
          >
            Salvar etapa
          </button>
        </div>
      </form>
    </Dialog>
  );
}
