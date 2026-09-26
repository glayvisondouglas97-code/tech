import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AutomationDialog } from '../components/automations/AutomationDialog';
import { AutomationEditor } from '../components/automations/AutomationEditor';
import { IconBack, IconConversas, IconPlus } from '../components/Icons';
import { useToast } from '../components/Toasts';
import { Empty } from '../components/ui';
import { errorMessage } from '../lib/api';
import { STATUS_INFO, TRIGGER_LABELS, useAutomationCache, useAutomations } from '../lib/automations';
import { fmtWhen, plural } from '../lib/format';

/**
 * Automações (só o dono e o administrador). `/automacoes` lista; `/automacoes/:id` abre o editor de etapas.
 * Por enquanto é só configuração: nenhuma automação, mesmo ativa, envia mensagem sozinha.
 */
export function AutomationsPage() {
  const { id } = useParams();
  if (id === undefined) return <AutomationList />;
  const number = Number(id);
  if (Number.isInteger(number) && number > 0) return <AutomationEditor key={number} id={number} />;
  return (
    <>
      <Link to="/automacoes" className="btn btn-ghost btn-sm auto-back">
        <IconBack size={16} /> Voltar para as automações
      </Link>
      <Empty title="Automação não encontrada" icon={<IconConversas />} />
    </>
  );
}

function AutomationList() {
  const navigate = useNavigate();
  const toast = useToast();
  const cache = useAutomationCache();
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const query = useAutomations(archived);
  const items = query.data ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Automações</h1>
          <p className="sub">
            Monte sequências de mensagens para os leads: cada etapa espera um tempo e envia um texto ou um
            áudio da biblioteca.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          <IconPlus /> Nova automação
        </button>
      </div>

      <p className="banner info auto-note">
        Automações <b>ativas</b> enviam mensagens de verdade pelo WhatsApp, no tempo de cada etapa. Elas param
        sozinhas quando o lead responde, se o telefone entrar em "não contatar" ou se você pausar ou arquivar.
      </p>

      <div className="seg auto-filter" role="radiogroup" aria-label="Mostrar automações">
        <button type="button" role="radio" aria-checked={!archived} onClick={() => setArchived(false)}>
          Em uso
        </button>
        <button type="button" role="radio" aria-checked={archived} onClick={() => setArchived(true)}>
          Arquivadas
        </button>
      </div>

      {query.isLoading ? (
        <div className="num-loading">
          <span className="spinner" />
        </div>
      ) : query.isError ? (
        <p className="banner bad" role="alert">
          {errorMessage(query.error)}
        </p>
      ) : items.length === 0 ? (
        <Empty
          title={archived ? 'Nenhuma automação arquivada' : 'Nenhuma automação ainda'}
          icon={<IconConversas />}
        >
          {!archived && (
            <>
              <p className="sub">Crie a primeira e monte as etapas dela.</p>
              <div className="row" style={{ marginTop: 14, justifyContent: 'center' }}>
                <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                  <IconPlus /> Criar a primeira automação
                </button>
              </div>
            </>
          )}
        </Empty>
      ) : (
        <ul className="auto-grid">
          {items.map((a) => {
            const status = STATUS_INFO[a.status];
            return (
              <li key={a.id}>
                <Link to={`/automacoes/${a.id}`} className="auto-card">
                  <span className="auto-card-top">
                    <h3>{a.name}</h3>
                    <span className={`pill t-${status.tone}`}>{status.label}</span>
                  </span>
                  {a.description && <span className="auto-card-desc">{a.description}</span>}
                  <span className="auto-card-meta">
                    <span>{plural(a.steps.length, 'etapa', 'etapas')}</span>
                    {a.runs.pending + a.runs.running > 0 && (
                      <span>
                        {plural(a.runs.pending + a.runs.running, 'lead em andamento', 'leads em andamento')}
                      </span>
                    )}
                    {a.runs.completed > 0 && (
                      <span>{plural(a.runs.completed, 'concluída', 'concluídas')}</span>
                    )}
                    <span>{TRIGGER_LABELS[a.trigger]}</span>
                    <span>Alterada {fmtWhen(a.updatedAt)}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {creating && (
        <AutomationDialog
          onClose={() => setCreating(false)}
          onSaved={(item) => {
            cache.setAutomation(item);
            toast('Automação criada. Agora adicione as etapas.');
            setCreating(false);
            navigate(`/automacoes/${item.id}`);
          }}
        />
      )}
    </>
  );
}
