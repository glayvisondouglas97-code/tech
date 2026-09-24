import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { LeadDetail } from '../../../shared/api';
import { api } from '../../lib/api';
import { leadPartner } from '../../lib/leads';
import { useMe } from '../../lib/session';
import { IconBack, IconBuilding, IconHistory } from '../Icons';
import { LeadDrawer } from '../LeadDrawer';
import { ResultPill } from '../ui';

/**
 * Faixa com o lead do Chamador ligado à conversa: empresa, sócio e situação (o resultado muda sozinho
 * quando a primeira mensagem sai e quando o lead responde). "Ver lead" abre a ficha com o histórico.
 */
export function LeadStrip({ leadId, label }: { leadId: number; label: string }) {
  const me = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  const fromLead = !!(location.state as { fromLead?: boolean } | null)?.fromLead;
  const [drawer, setDrawer] = useState(false);
  // Mesma consulta da ficha do lead: abrir a ficha não busca de novo. 404 = lead de outra pessoa.
  const q = useQuery({
    queryKey: ['lead', leadId],
    queryFn: () => api<LeadDetail>(`/leads/${leadId}`),
    retry: false,
  });
  const lead = q.data?.lead;
  const partner = lead ? leadPartner(lead) : null;

  return (
    <div className="wa-lead">
      <span className="wa-lead-ic" aria-hidden="true">
        <IconBuilding size={16} />
      </span>
      <div className="wa-lead-main" title={label}>
        <b>Lead</b>
        {lead ? (
          <>
            {lead.status === 'chamado' ? (
              <ResultPill result={lead.result} />
            ) : lead.status === 'pendente' ? (
              <span className="tag">
                {lead.assignedTo?.id === me.id
                  ? 'Na sua fila'
                  : lead.assignedTo
                    ? `Na fila de ${lead.assignedTo.name}`
                    : 'Na fila livre'}
              </span>
            ) : (
              <span className="tag bad">Não contatar</span>
            )}
            {partner && <span className="wa-lead-info">Sócio: {partner}</span>}
            <span className="wa-lead-info wa-lead-list">{lead.list.name}</span>
          </>
        ) : (
          <span className="wa-lead-info">{label}</span>
        )}
      </div>
      {lead && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          title="Ver lead e histórico"
          aria-label="Ver lead e histórico"
          onClick={() => setDrawer(true)}
        >
          <IconHistory size={15} />
          <span className="wa-lead-btn-text">Ver lead</span>
        </button>
      )}
      {fromLead && (
        <button
          type="button"
          className="btn btn-line btn-sm wa-lead-back"
          title="Voltar para a fila"
          aria-label="Voltar para a fila"
          onClick={() => navigate(-1)}
        >
          <IconBack size={15} />
          <span className="wa-lead-btn-text">Voltar para a fila</span>
        </button>
      )}
      <LeadDrawer leadId={drawer ? leadId : null} onClose={() => setDrawer(false)} />
    </div>
  );
}
