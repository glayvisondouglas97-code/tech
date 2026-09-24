import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { LeadDetail, TeamMember } from '../../shared/api';
import { api } from '../lib/api';
import { fmtWhen } from '../lib/format';
import { describeEvent, leadLabel, leadPartner, useLeadActions } from '../lib/leads';
import { useSession } from '../lib/session';
import { CallDialog } from './CallDialog';
import { ChatButton } from './ChatButton';
import { IconChat } from './Icons';
import { Dialog, ResultPill } from './ui';

/** Gaveta com os dados do lead e a linha do tempo completa (histórico de eventos). */
export function LeadDrawer({ leadId, onClose }: { leadId: number | null; onClose: () => void }) {
  const { me, can } = useSession();
  const actions = useLeadActions();
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState('');
  const q = useQuery({
    queryKey: ['lead', leadId],
    queryFn: () => api<LeadDetail>(`/leads/${leadId}`),
    enabled: leadId != null,
  });
  const team = useQuery({
    queryKey: ['team'],
    queryFn: () => api<TeamMember[]>('/team'),
    enabled: leadId != null && can('manageLeads'),
    staleTime: 60_000,
  });
  const lead = q.data?.lead;
  const manager = can('manageLeads');
  const mine = lead && (lead.calledBy?.id === me?.id || lead.assignedTo?.id === me?.id);

  return (
    <Dialog open={leadId != null} onClose={onClose} drawer title="Lead">
      {q.isLoading && <p className="sub">Carregando…</p>}
      {q.isError && <p className="error-text">Este lead não está mais disponível para você.</p>}
      {lead && (
        <>
          <div className="stack" style={{ gap: 8 }}>
            <h2 style={{ fontSize: 22 }}>{leadLabel(lead)}</h2>
            {leadPartner(lead) && <p className="lead-socio">Sócio / proprietário: {leadPartner(lead)}</p>}
            <div className="lead-meta" style={{ fontSize: 14 }}>
              <span className="phone">{lead.phoneDisplay}</span>
              {lead.phoneType === 'fixo' && <span className="tag">Fixo</span>}
              <span className="tag">{lead.list.name}</span>
              {lead.status === 'bloqueado' && <span className="tag bad">Não contatar</span>}
            </div>
            {lead.extraPhones.length > 0 && (
              <p className="sub">Outros telefones: {lead.extraPhones.map((p) => p.display).join(' · ')}</p>
            )}
            <div className="row mt8">
              {lead.calledAt ? (
                <>
                  <ResultPill result={lead.result} />
                  <span className="sub">
                    por {lead.calledBy?.name}, {fmtWhen(lead.calledAt)}
                  </span>
                </>
              ) : lead.status === 'pendente' ? (
                <span className="sub">
                  {lead.assignedTo ? `Na fila de ${lead.assignedTo.name}` : 'Na fila livre'}
                </span>
              ) : null}
            </div>
            {lead.callbackAt && <p className="banner info">Retorno agendado: {fmtWhen(lead.callbackAt)}</p>}
            {lead.note && <div className="note-text">{lead.note}</div>}
            {Object.keys(lead.extra).length > 0 && (
              <div className="focus-extras mt8">
                {Object.entries(lead.extra).map(([k, v]) => (
                  <div key={k}>
                    <span>{k}</span>
                    {v}
                  </div>
                ))}
              </div>
            )}
          </div>

          {!lead.anonymized && lead.status !== 'bloqueado' && (
            <div className="row">
              <ChatButton lead={lead} className="btn btn-wa btn-sm">
                <IconChat size={16} />
                Abrir conversa
              </ChatButton>
              {(mine || manager) && lead.calledAt && (
                <button type="button" className="btn btn-line btn-sm" onClick={() => setEditing(true)}>
                  Atualizar contato
                </button>
              )}
              {(mine || manager) && lead.calledAt && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => actions.requeue(lead, 'minha')}
                >
                  Chamar de novo
                </button>
              )}
              {(mine || manager) && !(lead.status === 'pendente' && !lead.assignedTo) && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => actions.requeue(lead, 'livre')}
                >
                  Devolver à fila livre
                </button>
              )}
            </div>
          )}
          {manager && !lead.anonymized && lead.status !== 'bloqueado' && (
            <div className="row">
              <label className="vh" htmlFor="pass-to">
                Passar para
              </label>
              <select
                id="pass-to"
                className="select input"
                style={{ maxWidth: 240 }}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Passar para…</option>
                {(team.data ?? [])
                  .filter((u) => u.id !== lead.assignedTo?.id || lead.status !== 'pendente')
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="btn btn-line btn-sm"
                disabled={!target}
                onClick={() => {
                  const u = team.data?.find((x) => x.id === target);
                  void actions.requeue(lead, target, u?.name);
                  setTarget('');
                }}
              >
                Passar
              </button>
            </div>
          )}

          <section>
            <h3 style={{ marginBottom: 12 }}>Histórico</h3>
            <ol className="timeline">
              {q.data?.events.map((e) => {
                const d = describeEvent(e);
                return (
                  <li key={e.id}>
                    <span className="dot" aria-hidden="true" />
                    <div>
                      <div className="t">{d.title}</div>
                      {d.detail && <div className="d">{d.detail}</div>}
                      <div className="w">
                        {e.user?.name ?? 'Sistema'} · {fmtWhen(e.createdAt)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
          {editing && <CallDialog lead={lead} onClose={() => setEditing(false)} />}
        </>
      )}
    </Dialog>
  );
}
