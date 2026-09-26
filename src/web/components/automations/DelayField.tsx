import { useId } from 'react';
import { DELAY_UNITS, type DelayUnit, formatDelay, parseDelay } from '../../lib/automations';

export interface DelayDraft {
  /** O que foi digitado (texto, para aceitar "1,5" e campo vazio enquanto se digita). */
  value: string;
  unit: DelayUnit;
}

/** Quantidade + unidade (segundos, minutos, horas, dias). O que fica guardado é o total em segundos. */
export function DelayField({
  label,
  draft,
  onChange,
  disabled,
}: {
  label: string;
  draft: DelayDraft;
  onChange: (draft: DelayDraft) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const seconds = parseDelay(draft.value, draft.unit);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="auto-delay">
        <input
          id={id}
          className="input"
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          value={draft.value}
          disabled={disabled}
          aria-invalid={seconds === null}
          onChange={(e) => onChange({ ...draft, value: e.target.value })}
        />
        <select
          className="select"
          aria-label="Unidade de tempo"
          value={draft.unit}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, unit: e.target.value as DelayUnit })}
        >
          {DELAY_UNITS.map((u) => (
            <option key={u.unit} value={u.unit}>
              {u.label}
            </option>
          ))}
        </select>
      </div>
      <small aria-live="polite">
        {seconds === null
          ? 'Informe um tempo de 0 até 1 ano.'
          : `Espera: ${formatDelay(seconds).toLowerCase()}`}
      </small>
    </div>
  );
}
