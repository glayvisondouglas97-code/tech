import { useEffect, useState } from 'react';
import type { LeadItem } from '../../shared/api';
import { RESULTS, type ResultId } from '../../shared/results';
import { isoToLocalInput, localInputToIso, ymdSP } from '../lib/format';
import { leadLabel, useLeadActions } from '../lib/leads';
import { Dialog } from './ui';

function quickTime(kind: 'h1' | 'amanha' | 'd2' | 'semana'): string {
  const now = new Date();
  if (kind === 'h1') return isoToLocalInput(new Date(now.getTime() + 3_600_000).toISOString());
  const days = kind === 'amanha' ? 1 : kind === 'd2' ? 2 : 7;
  const d = new Date(now.getTime() + days * 86_400_000);
  return `${ymdSP(d)}T09:00`;
}

/**
 * Registrar contato: resultado, observação e retorno agendado.
 * Serve para marcar um lead da fila ou para atualizar um lead já chamado.
 */
export function CallDialog({
  lead,
  onClose,
  onDone,
}: {
  lead: LeadItem | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const actions = useLeadActions();
  const [result, setResult] = useState<ResultId>('enviado');
  const [note, setNote] = useState('');
  const [callback, setCallback] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = lead?.status === 'pendente';

  useEffect(() => {
    if (!lead) return;
    setResult(lead.result ?? 'enviado');
    setNote(lead.note ?? '');
    setCallback(isoToLocalInput(lead.callbackAt));
  }, [lead]);

  if (!lead)
    return (
      <Dialog open={false} onClose={onClose}>
        {null}
      </Dialog>
    );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!lead) return;
    setBusy(true);
    const callbackAt = result === 'sem_whatsapp' ? null : localInputToIso(callback);
    const ok = pending
      ? await actions.markCalled(lead, result, { note: note.trim(), callbackAt })
      : await actions.update(lead, { result, note: note.trim() || null, callbackAt }, 'Contato atualizado.');
    setBusy(false);
    if (ok) {
      onDone?.();
      onClose();
    }
  }

  return (
    <Dialog open onClose={onClose} title={pending ? 'Registrar contato' : 'Atualizar contato'}>
      <form onSubmit={submit} className="stack" style={{ gap: 16 }}>
        <p className="sub">
          <b style={{ color: 'var(--ink)' }}>{leadLabel(lead)}</b> ·{' '}
          <span className="phone">{lead.phoneDisplay}</span>
        </p>
        <fieldset className="dist" style={{ margin: 0 }}>
          <legend>Resultado</legend>
          <div className="chips" role="radiogroup" aria-label="Resultado">
            {RESULTS.map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={result === r.id}
                className={`chip-btn t-${r.tone}`}
                onClick={() => setResult(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="field">
          Observação
          <textarea
            className="input"
            rows={3}
            maxLength={1000}
            value={note}
            placeholder="Ex.: pediu para retornar sexta de manhã"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {result !== 'sem_whatsapp' && (
          <div className="field">
            <label htmlFor="cb-when">
              Agendar retorno <small>(opcional; aparece na sua fila no horário)</small>
            </label>
            <div className="row">
              <input
                id="cb-when"
                type="datetime-local"
                className="input"
                style={{ maxWidth: 240 }}
                value={callback}
                onChange={(e) => setCallback(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setCallback(quickTime('h1'))}
              >
                Daqui 1 h
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setCallback(quickTime('amanha'))}
              >
                Amanhã 9h
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setCallback(quickTime('semana'))}
              >
                Em 7 dias
              </button>
              {callback && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCallback('')}>
                  Sem retorno
                </button>
              )}
            </div>
          </div>
        )}
        <div className="row end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Salvando…' : pending ? 'Marcar como chamado' : 'Salvar'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
