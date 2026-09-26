import type { AutomationCondition } from '../../../shared/api';
import {
  AUTOMATION_CONDITION_FIELDS,
  AUTOMATION_CONDITION_OPERATORS,
  AUTOMATION_MAX_CONDITIONS,
  type AutomationConditionField,
  type AutomationConditionOperator,
  LEAD_STATUSES,
} from '../../../shared/automations';
import { RESULTS } from '../../../shared/results';
import {
  CONDITION_FIELD_LABELS,
  LEAD_STATUS_LABELS,
  newCondition,
  OPERATOR_LABELS,
} from '../../lib/automations';
import { IconPlus, IconTrash } from '../Icons';

export interface ListOption {
  id: string;
  name: string;
}

/** Valor da condição: cada campo mostra as opções dele. */
function ValueSelect({
  condition,
  lists,
  label,
  disabled,
  onChange,
}: {
  condition: AutomationCondition;
  lists: ListOption[];
  label: string;
  disabled?: boolean;
  onChange: (next: AutomationCondition) => void;
}) {
  switch (condition.field) {
    case 'lead_result':
      return (
        <select
          className="select"
          aria-label={label}
          value={condition.value}
          disabled={disabled}
          onChange={(e) => onChange({ ...condition, value: e.target.value as typeof condition.value })}
        >
          {RESULTS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      );
    case 'lead_replied':
      return (
        <select
          className="select"
          aria-label={label}
          value={condition.value ? 'sim' : 'nao'}
          disabled={disabled}
          onChange={(e) => onChange({ ...condition, value: e.target.value === 'sim' })}
        >
          <option value="sim">Sim</option>
          <option value="nao">Não</option>
        </select>
      );
    case 'lead_status':
      return (
        <select
          className="select"
          aria-label={label}
          value={condition.value}
          disabled={disabled}
          onChange={(e) => onChange({ ...condition, value: e.target.value as typeof condition.value })}
        >
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {LEAD_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      );
    case 'lead_list': {
      // Lista que não existe mais (ou ainda não carregou): continua na seleção para não sumir em silêncio.
      const known = lists.some((l) => l.id === condition.value);
      return (
        <select
          className="select"
          aria-label={label}
          value={condition.value}
          disabled={disabled}
          aria-invalid={condition.value === ''}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
        >
          <option value="">{lists.length ? 'Escolha a lista…' : 'Nenhuma lista importada'}</option>
          {condition.value && !known && <option value={condition.value}>Lista removida</option>}
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      );
    }
  }
}

/**
 * Editor das condições de uma etapa: campo, operador e valor, quantas forem precisas.
 * Só configura e guarda; nesta versão nenhuma condição é aplicada.
 */
export function ConditionsEditor({
  conditions,
  lists,
  onChange,
  disabled,
}: {
  conditions: AutomationCondition[];
  lists: ListOption[];
  onChange: (next: AutomationCondition[]) => void;
  disabled?: boolean;
}) {
  const replace = (index: number, next: AutomationCondition) =>
    onChange(conditions.map((c, i) => (i === index ? next : c)));

  return (
    <div className="auto-conds">
      {conditions.length === 0 ? (
        <p className="sub small">Sem condições: a etapa vale para todos os leads.</p>
      ) : (
        <ul className="auto-cond-list">
          {conditions.map((c, index) => {
            const n = index + 1;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: as condições não têm id próprio; a ordem é a identidade
              <li key={index} className="auto-cond">
                <select
                  className="select"
                  aria-label={`Campo da condição ${n}`}
                  value={c.field}
                  disabled={disabled}
                  onChange={(e) =>
                    replace(index, newCondition(e.target.value as AutomationConditionField, lists[0]?.id))
                  }
                >
                  {AUTOMATION_CONDITION_FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {CONDITION_FIELD_LABELS[f]}
                    </option>
                  ))}
                </select>
                <select
                  className="select"
                  aria-label={`Operador da condição ${n}`}
                  value={c.operator}
                  disabled={disabled}
                  onChange={(e) =>
                    replace(index, { ...c, operator: e.target.value as AutomationConditionOperator })
                  }
                >
                  {AUTOMATION_CONDITION_OPERATORS.map((o) => (
                    <option key={o} value={o}>
                      {OPERATOR_LABELS[o]}
                    </option>
                  ))}
                </select>
                <div className="auto-cond-value">
                  <ValueSelect
                    condition={c}
                    lists={lists}
                    label={`Valor da condição ${n}`}
                    disabled={disabled}
                    onChange={(next) => replace(index, next)}
                  />
                </div>
                <button
                  type="button"
                  className="icon-btn danger"
                  aria-label={`Remover a condição ${n}`}
                  title="Remover condição"
                  disabled={disabled}
                  onClick={() => onChange(conditions.filter((_, i) => i !== index))}
                >
                  <IconTrash />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="row">
        <button
          type="button"
          className="btn btn-line btn-sm"
          disabled={disabled || conditions.length >= AUTOMATION_MAX_CONDITIONS}
          onClick={() => onChange([...conditions, newCondition('lead_result')])}
        >
          <IconPlus size={16} /> Adicionar condição
        </button>
        {conditions.length > 1 && (
          <span className="sub small">A etapa vale só se todas forem verdadeiras.</span>
        )}
      </div>
    </div>
  );
}
