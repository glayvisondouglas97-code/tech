import { useState } from 'react';
import {
  CALLED_BEFORE_LABELS,
  CALLED_BEFORE_OPTIONS,
  CAMPAIGN_LEAD_STATUSES,
  CAMPAIGN_PHONE_TYPES,
  type CalledBefore,
  PHONE_TYPE_LABELS,
  STATUS_FILTER_LABELS,
} from '../../../shared/campaign-plan';
import { NOT_A_CONTACT, RESULTS, type ResultId } from '../../../shared/results';
import type { CampaignFormState } from '../../lib/campaign-form';
import { parseDdds } from '../../lib/campaign-form';

const toggle = <T,>(list: readonly T[], value: T): T[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

/**
 * Filtros opcionais do público, só com dados que o lead já tem: DDD, situação, resultado, tipo de telefone e "chamado
 * antes". A lista continua sendo a base; sem filtro, vale a regra padrão (fila livre, com celular). Quem decide quem entra
 * é o servidor: aqui só se escolhe.
 */
export function CampaignFilterFields({
  form,
  onChange,
}: {
  form: CampaignFormState;
  onChange: (patch: Partial<CampaignFormState>) => void;
}) {
  const invalid = parseDdds(form.dddText).invalid;
  // Abre sozinho só na entrada (editando uma campanha que já tem filtros); depois quem manda é a pessoa.
  const [open, setOpen] = useState(() => hasFilters(form));
  return (
    <details
      className="camp-filters"
      data-testid="filtros"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Filtros do público (opcional)</summary>
      <div className="camp-filters-body">
        <label className="field">
          <span>DDD</span>
          <input
            className="input"
            value={form.dddText}
            onChange={(e) => onChange({ dddText: e.target.value })}
            placeholder="Ex.: 41, 42"
            inputMode="numeric"
            aria-invalid={invalid.length > 0}
            data-testid="filtro-ddd"
          />
          <small>Vários DDDs separados por vírgula. Vazio = todos.</small>
        </label>

        <fieldset className="field camp-check-group">
          <legend>Situação do lead</legend>
          {CAMPAIGN_LEAD_STATUSES.map((s) => (
            <label key={s} className="camp-check">
              <input
                type="checkbox"
                checked={form.status.includes(s)}
                onChange={() => onChange({ status: toggle(form.status, s) })}
                data-testid={`filtro-situacao-${s}`}
              />
              {STATUS_FILTER_LABELS[s]}
            </label>
          ))}
          <small>Lead bloqueado nunca entra. Quem já tem atendente fica com ele.</small>
        </fieldset>

        <fieldset className="field camp-check-group">
          <legend>Resultado</legend>
          {RESULTS.filter((r) => r.id !== NOT_A_CONTACT).map((r) => (
            <label key={r.id} className="camp-check">
              <input
                type="checkbox"
                checked={form.results.includes(r.id as ResultId)}
                onChange={() => onChange({ results: toggle(form.results, r.id as ResultId) })}
                data-testid={`filtro-resultado-${r.id}`}
              />
              {r.label}
            </label>
          ))}
          <small>Sem nenhum marcado, vale qualquer resultado. "Sem WhatsApp" nunca entra.</small>
        </fieldset>

        <fieldset className="field camp-check-group">
          <legend>Tipo de telefone</legend>
          {CAMPAIGN_PHONE_TYPES.map((t) => (
            <label key={t} className="camp-check">
              <input
                type="checkbox"
                checked={form.phoneTypes.includes(t)}
                onChange={() => onChange({ phoneTypes: toggle(form.phoneTypes, t) })}
                data-testid={`filtro-telefone-${t}`}
              />
              {PHONE_TYPE_LABELS[t]}
            </label>
          ))}
          <small>Sem nenhum marcado, entram celulares (telefone fixo raramente tem WhatsApp).</small>
        </fieldset>

        <label className="field">
          <span>Chamado antes?</span>
          <select
            className="select"
            value={form.calledBefore}
            onChange={(e) => onChange({ calledBefore: e.target.value as CalledBefore })}
            data-testid="filtro-chamado-antes"
          >
            {CALLED_BEFORE_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {CALLED_BEFORE_LABELS[o]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </details>
  );
}

function hasFilters(f: CampaignFormState): boolean {
  return (
    f.dddText.trim() !== '' ||
    f.results.length > 0 ||
    f.phoneTypes.length > 0 ||
    f.calledBefore !== 'any' ||
    !(f.status.length === 1 && f.status[0] === 'pendente')
  );
}
