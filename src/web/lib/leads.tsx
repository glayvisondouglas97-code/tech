import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import type { LeadEvent, LeadItem, QueueResponse } from '../../shared/api';
import { type ResultId, resultLabel } from '../../shared/results';
import { useToast } from '../components/Toasts';
import { ApiError, api, errorMessage } from './api';
import { fmtWhen } from './format';

/** Nome principal do lead: a empresa (PJ); sem empresa, o nome do sócio. */
export function leadLabel(l: { name: string; company?: string }): string {
  return l.company || l.name || 'Lead sem nome';
}

/** Linha secundária: o sócio / proprietário, quando o nome principal é a empresa. */
export function leadPartner(l: { name: string; company?: string }): string | null {
  return l.company && l.name ? l.name : null;
}

/** Iniciais da empresa para o avatar, ignorando o tipo societário (Ltda, ME, S/A...). */
const SUFFIX = /^(ltda|me|mei|epp|eireli|s\/?a|cia|\d+)\.?$/i;
export function companyInitials(label: string): string {
  const words = label
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}/]/gu, ''))
    .filter((w) => w && !SUFFIX.test(w));
  const first = words[0]?.[0] ?? label[0] ?? '?';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Ações sobre um lead, com aviso de "Desfazer" e atualização das telas. */
export function useLeadActions() {
  const qc = useQueryClient();
  const toast = useToast();

  const refresh = useCallback(() => {
    for (const key of ['queue', 'queue-stats', 'queue-ddds', 'leads', 'lead', 'dashboard'])
      qc.invalidateQueries({ queryKey: [key] });
  }, [qc]);

  const dropFromQueue = useCallback(
    (id: number) => {
      qc.setQueriesData<QueueResponse>({ queryKey: ['queue'] }, (old) =>
        old
          ? { ...old, items: old.items.filter((i) => i.id !== id), total: Math.max(0, old.total - 1) }
          : old,
      );
    },
    [qc],
  );

  const fail = useCallback(
    (err: unknown) => {
      toast(errorMessage(err), { tone: 'bad' });
      refresh();
    },
    [toast, refresh],
  );

  const undo = useCallback(
    async (lead: LeadItem) => {
      try {
        await api(`/leads/${lead.id}/undo`, { method: 'POST' });
        toast(`${leadLabel(lead)} voltou para a sua fila.`);
      } catch (err) {
        fail(err);
      } finally {
        refresh();
      }
    },
    [toast, fail, refresh],
  );

  const markCalled = useCallback(
    async (lead: LeadItem, result: ResultId, extra: { note?: string; callbackAt?: string | null } = {}) => {
      dropFromQueue(lead.id);
      try {
        const updated = await api<LeadItem>(`/leads/${lead.id}/call`, { body: { result, ...extra } });
        toast(
          result === 'sem_whatsapp'
            ? `${leadLabel(lead)}: marcado como sem WhatsApp.`
            : `${leadLabel(lead)}: marcado como chamado.`,
          {
            action: { label: 'Desfazer', fn: () => void undo(updated) },
          },
        );
        return updated;
      } catch (err) {
        fail(err);
        return null;
      } finally {
        refresh();
      }
    },
    [dropFromQueue, toast, undo, fail, refresh],
  );

  const update = useCallback(
    async (
      lead: LeadItem,
      patch: { result?: ResultId; note?: string | null; callbackAt?: string | null },
      okMsg?: string,
    ) => {
      try {
        const updated = await api<LeadItem>(`/leads/${lead.id}`, {
          method: 'PATCH',
          body: { version: lead.version, ...patch },
        });
        if (okMsg) toast(okMsg);
        return updated;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) toast(err.message, { tone: 'warn', ms: 8000 });
        else fail(err);
        return null;
      } finally {
        refresh();
      }
    },
    [toast, fail, refresh],
  );

  const requeue = useCallback(
    async (lead: LeadItem, to: 'livre' | 'minha' | string, toName?: string) => {
      if (lead.status === 'pendente') dropFromQueue(lead.id);
      try {
        await api(`/leads/${lead.id}/requeue`, { body: { to } });
        toast(
          to === 'livre'
            ? `${leadLabel(lead)} voltou para a fila livre.`
            : to === 'minha'
              ? `${leadLabel(lead)} voltou para a sua fila.`
              : `${leadLabel(lead)} foi para a fila de ${toName ?? 'outra pessoa'}.`,
        );
      } catch (err) {
        fail(err);
      } finally {
        refresh();
      }
    },
    [dropFromQueue, toast, fail, refresh],
  );

  const optOut = useCallback(
    async (lead: LeadItem) => {
      dropFromQueue(lead.id);
      try {
        await api(`/leads/${lead.id}/optout`, { body: {} });
        toast(`${leadLabel(lead)} não será mais contatado. O número foi para a lista de não contatar.`);
      } catch (err) {
        fail(err);
      } finally {
        refresh();
      }
    },
    [dropFromQueue, toast, fail, refresh],
  );

  return useMemo(
    () => ({ markCalled, undo, update, requeue, optOut, refresh }),
    [markCalled, undo, update, requeue, optOut, refresh],
  );
}

const WA_STATUS: Record<string, string> = {
  sent: 'Enviada',
  delivered: 'Entregue',
  read: 'Lida',
  failed: 'Falhou',
};

/** Texto de cada evento do histórico. */
export function describeEvent(e: LeadEvent): { title: string; detail?: string } {
  const d = e.data as Record<string, string | null | boolean | undefined>;
  switch (e.type) {
    case 'importado':
      return {
        title: `Importado na lista "${d.lista ?? ''}"`,
        detail: d.para_nome ? `Distribuído para ${d.para_nome}` : undefined,
      };
    case 'pegou':
      return { title: 'Pegou da fila livre', detail: d.ddd ? `Pedido só do DDD ${d.ddd}` : undefined };
    case 'abriu_whatsapp':
      return { title: 'Abriu a conversa no WhatsApp' };
    case 'chamado':
      return d.automatico
        ? {
            title: 'Chamou pelo WhatsApp do sistema',
            detail: `${resultLabel(String(d.resultado ?? 'enviado'))}${d.numero ? ` · pelo número ${d.numero}` : ''}`,
          }
        : { title: 'Marcou como chamado', detail: resultLabel(String(d.resultado ?? 'enviado')) };
    case 'resultado':
      return {
        title: d.automatico ? 'Resultado mudou sozinho (o lead respondeu)' : 'Mudou o resultado',
        detail: `${d.de ? resultLabel(String(d.de)) : '—'} → ${resultLabel(String(d.para))}`,
      };
    case 'observacao':
      return { title: 'Observação', detail: d.texto ? String(d.texto) : '(observação apagada)' };
    case 'desfeito':
      return {
        title: 'Desfez a marcação',
        detail: d.resultado ? `Estava como ${resultLabel(String(d.resultado))}` : undefined,
      };
    case 'devolvido':
      return {
        title: 'Devolvido à fila livre',
        detail:
          [d.de_nome ? `Estava com ${d.de_nome}` : null, d.motivo ? String(d.motivo) : null]
            .filter(Boolean)
            .join(' · ') || undefined,
      };
    case 'atribuido':
      return {
        title: `Passou para ${d.para_nome ?? 'outra pessoa'}`,
        detail: d.de_nome ? `Estava com ${d.de_nome}` : undefined,
      };
    case 'expirado':
      return {
        title: 'Voltou sozinho para a fila livre',
        detail:
          [d.de_nome ? `Estava com ${d.de_nome}` : null, d.motivo].filter(Boolean).join(' · ') || undefined,
      };
    case 'retorno_agendado':
      return { title: 'Agendou retorno', detail: fmtWhen(String(d.para)) };
    case 'retorno_cancelado':
      return { title: 'Retorno concluído ou cancelado' };
    case 'bloqueado':
      return { title: 'Entrou na lista de não contatar', detail: d.motivo ? String(d.motivo) : undefined };
    case 'desbloqueado':
      return { title: 'Saiu da lista de não contatar' };
    case 'whatsapp_resposta':
      return { title: 'Respondeu pelo WhatsApp', detail: d.texto ? String(d.texto) : undefined };
    case 'whatsapp_status':
      return { title: 'Status da mensagem', detail: WA_STATUS[String(d.status)] ?? String(d.status) };
    case 'anonimizado':
      return { title: 'Dados anonimizados (LGPD)' };
    default:
      return { title: e.type };
  }
}
