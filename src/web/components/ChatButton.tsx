import { useQuery } from '@tanstack/react-query';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { LeadItem } from '../../shared/api';
import type { LeadChatResult, LeadConversationRef } from '../../shared/conversations';
import { ApiError, api, errorMessage } from '../lib/api';
import { leadLabel, useLeadActions } from '../lib/leads';
import { useSession } from '../lib/session';
import { formatPhone, instanceColor, instanceLabel, useWaInstances } from '../lib/whatsapp';
import { useToast } from './Toasts';
import { Dialog } from './ui';

const LAST_NUMBER_KEY = 'cl_ultimo_numero';

function lastNumber(): number | null {
  try {
    return Number(localStorage.getItem(LAST_NUMBER_KEY)) || null;
  } catch {
    return null;
  }
}

function rememberNumber(id: number) {
  try {
    localStorage.setItem(LAST_NUMBER_KEY, String(id));
  } catch {}
}

/**
 * Botão "Chamar" do lead: pergunta por qual número falar e abre a conversa dentro do sistema,
 * com a caixa de texto vazia (pronta para gravar o áudio). Sem WhatsApp configurado, não aparece.
 */
export function ChatButton({
  lead,
  className,
  title,
  children,
}: {
  lead: LeadItem;
  className: string;
  title?: string;
  children: ReactNode;
}) {
  const { config } = useSession();
  const [open, setOpen] = useState(false);
  if (!config?.whatsapp) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        title={title}
        aria-label={title}
        data-chamar=""
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      {open && <ChooseNumberDialog lead={lead} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Janela "Por qual número?": números conectados, com atalho 1 a 9 e o último usado já em foco. */
function ChooseNumberDialog({ lead, onClose }: { lead: LeadItem; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const actions = useLeadActions();
  const { can } = useSession();
  const instances = useWaInstances().data;
  // Sempre atualizado: a conversa pode ter sido aberta agora há pouco (por esta ou por outra pessoa).
  const opened = useQuery({
    queryKey: ['lead-conversations', lead.id],
    queryFn: () => api<LeadConversationRef[]>(`/leads/${lead.id}/conversations`),
    staleTime: 0,
  });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noWhatsapp, setNoWhatsapp] = useState(false);
  const preferredRef = useRef<HTMLButtonElement>(null);

  const list = instances ?? [];
  const openedIds = new Set((opened.data ?? []).map((c) => c.instanceId));
  const connected = list.filter((i) => i.status === 'open');
  // Em foco: o número em que já existe conversa com o lead; senão o último usado; senão o primeiro conectado.
  const preferred =
    connected.find((i) => openedIds.has(i.id)) ??
    connected.find((i) => i.id === lastNumber()) ??
    connected[0];

  async function choose(instanceId: number) {
    if (busyId !== null) return;
    setBusyId(instanceId);
    setError(null);
    try {
      const r = await api<LeadChatResult>(`/leads/${lead.id}/conversation`, {
        body: { instanceId, sendAudio: true },
      });
      rememberNumber(instanceId);
      actions.refresh();
      if (r.warning) toast(r.warning, { tone: 'warn', ms: 9000 });
      if (r.audio?.sent) toast(`Áudio enviado: ${r.audio.label}`);
      else if (r.audio?.reason === 'sem_audios')
        toast('Conversa aberta. Nenhum áudio salvo para enviar — grave um em Áudios.', {
          tone: 'warn',
          ms: 9000,
        });
      else if (r.audio && !r.audio.sent)
        toast('A conversa abriu, mas não consegui enviar o áudio. Grave um na hora.', {
          tone: 'warn',
          ms: 9000,
        });
      onClose();
      navigate(`/conversas/${r.conversationId}`, { state: { fromLead: true } });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'sem_whatsapp') setNoWhatsapp(true);
      else setError(errorMessage(err));
      setBusyId(null);
    }
  }
  const latest = useRef({ choose, list });
  latest.current = { choose, list };

  // biome-ignore lint/correctness/useExhaustiveDependencies: foca quando a lista de números carrega
  useEffect(() => {
    preferredRef.current?.focus();
  }, [preferred?.id, opened.isSuccess]);

  // Atalhos: 1 a 9 escolhem o número pela posição na lista.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
      const instance = latest.current.list[Number(e.key) - 1];
      if (instance?.status === 'open') {
        e.preventDefault();
        void latest.current.choose(instance.id);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  async function markNoWhatsapp() {
    onClose();
    if (lead.status === 'pendente') await actions.markCalled(lead, 'sem_whatsapp');
    else
      await actions.update(
        lead,
        { result: 'sem_whatsapp' },
        `${leadLabel(lead)}: marcado como sem WhatsApp.`,
      );
  }

  return (
    <Dialog open onClose={onClose} title={noWhatsapp ? 'Sem WhatsApp' : 'Chamar pelo WhatsApp'}>
      <p className="sub">
        <b style={{ color: 'var(--ink)' }}>{leadLabel(lead)}</b> ·{' '}
        <span className="phone">{lead.phoneDisplay}</span>
      </p>
      {noWhatsapp ? (
        <>
          <p className="banner">O número {lead.phoneDisplay} não tem WhatsApp.</p>
          <div className="row end">
            <button type="button" className="btn btn-line" onClick={onClose}>
              Fechar
            </button>
            <button type="button" className="btn btn-primary" onClick={markNoWhatsapp}>
              Marcar como Sem WhatsApp
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="eyebrow">Por qual número?</p>
          <p className="sub">
            Ao escolher, o sistema envia um áudio salvo para o lead. Cada número inicia no máximo 20 contatos
            por dia (manuais e automáticos somados).
          </p>
          {!instances ? (
            <div className="num-loading">
              <span className="spinner" />
            </div>
          ) : list.length === 0 ? (
            <p className="banner">
              {can('seeAllNumbers')
                ? 'Nenhum número de WhatsApp cadastrado.'
                : 'Você ainda não tem número de WhatsApp.'}{' '}
              <Link to="/numeros">Cadastrar em Números</Link>
            </p>
          ) : (
            <ul className="num-pick">
              {list.map((instance, index) => {
                const ok = instance.status === 'open';
                return (
                  <li key={instance.id}>
                    <button
                      type="button"
                      className="num-opt"
                      ref={instance.id === preferred?.id ? preferredRef : undefined}
                      disabled={!ok || busyId !== null}
                      aria-busy={busyId === instance.id}
                      onClick={() => choose(instance.id)}
                      style={{ '--wa-color': instanceColor(instance.id) } as CSSProperties}
                    >
                      <i aria-hidden="true" />
                      <span className="num-main">
                        <b>{instanceLabel(instance)}</b>
                        <small>
                          {instance.phone ? formatPhone(instance.phone) : 'Sem telefone'} ·{' '}
                          {instance.usage.total}/{instance.usage.limit} hoje
                        </small>
                      </span>
                      {openedIds.has(instance.id) && <span className="tag info">Já conversou</span>}
                      {ok && instance.usage.limitReached && !openedIds.has(instance.id) && (
                        <span className="tag bad">Limite diário atingido</span>
                      )}
                      {!ok && <span className="tag bad">Desconectado</span>}
                      {busyId === instance.id ? (
                        <span className="spinner num-spin" />
                      ) : ok && index < 9 ? (
                        <kbd>{index + 1}</kbd>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {busyId !== null && (
            <p className="sub" role="status">
              Conferindo se o lead tem WhatsApp…
            </p>
          )}
          {instances && list.length > 0 && connected.length === 0 && (
            <p className="banner">
              Nenhum número conectado agora. <Link to="/numeros">Reconectar em Números</Link>
            </p>
          )}
          {error && (
            <p className="banner bad" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
