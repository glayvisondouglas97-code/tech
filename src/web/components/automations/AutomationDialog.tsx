import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { AutomationItem } from '../../../shared/api';
import {
  AUTOMATION_DESCRIPTION_MAX,
  AUTOMATION_NAME_MAX,
  AUTOMATION_TRIGGERS,
  type AutomationTrigger,
} from '../../../shared/automations';
import { errorMessage } from '../../lib/api';
import { automationsApi, TRIGGER_HELP, TRIGGER_LABELS } from '../../lib/automations';
import { Dialog } from '../ui';

/** Janela para criar uma automação ou editar nome, descrição e gatilho de uma que já existe. */
export function AutomationDialog({
  automation,
  onClose,
  onSaved,
}: {
  /** Vazio = automação nova. */
  automation?: AutomationItem;
  onClose: () => void;
  onSaved: (item: AutomationItem) => void;
}) {
  const [name, setName] = useState(automation?.name ?? '');
  const [description, setDescription] = useState(automation?.description ?? '');
  const [trigger, setTrigger] = useState<AutomationTrigger>(automation?.trigger ?? 'manual');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const data = { name: name.trim(), description: description.trim() || null, trigger };
      return automation ? automationsApi.update(automation.id, data) : automationsApi.create(data);
    },
    onSuccess: onSaved,
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Dê um nome para a automação.');
    save.mutate();
  }

  return (
    <Dialog open onClose={onClose} title={automation ? 'Editar automação' : 'Nova automação'}>
      <form className="stack" style={{ gap: 16 }} onSubmit={submit} noValidate>
        <label className="field">
          <span>Nome</span>
          <input
            className="input"
            type="text"
            value={name}
            maxLength={AUTOMATION_NAME_MAX}
            placeholder="Ex.: Follow-up de leads"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Descrição (opcional)</span>
          <textarea
            className="input"
            rows={3}
            value={description}
            maxLength={AUTOMATION_DESCRIPTION_MAX}
            placeholder="Para que serve esta automação?"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Gatilho</span>
          <select
            className="select"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value as AutomationTrigger)}
          >
            {AUTOMATION_TRIGGERS.map((t) => (
              <option
                key={t}
                value={t}
                disabled={t === 'lead_created' && automation?.trigger !== 'lead_created'}
              >
                {TRIGGER_LABELS[t]}
                {t === 'lead_created' ? ' (ainda não disponível)' : ''}
              </option>
            ))}
          </select>
          <small>{TRIGGER_HELP[trigger]}</small>
        </label>

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
            {automation ? 'Salvar' : 'Criar automação'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
