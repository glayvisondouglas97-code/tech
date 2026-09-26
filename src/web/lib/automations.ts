/** Automações: chamadas à API, cache do React Query e formatos de exibição (rótulos, espera, condições). */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type {
  AutomationCondition,
  AutomationItem,
  AutomationRunItem,
  AutomationStep,
  AutomationStepInput,
  CampaignCalendar,
  CampaignDetail,
  CampaignInput,
  CampaignItem,
  CampaignPreview,
  CampaignStatsResult,
  CampaignUpdateInput,
} from '../../shared/api';
import {
  AUTOMATION_MAX_DELAY_SECONDS,
  type AutomationActionType,
  type AutomationAudioMode,
  type AutomationConditionField,
  type AutomationRunStatus,
  type AutomationSettableStatus,
  type AutomationStatus,
  type AutomationStepRunStatus,
  type AutomationTrigger,
  type CampaignStatus,
} from '../../shared/automations';
import type { ResultId } from '../../shared/results';
import { api, qs } from './api';
import { useRealtimeOnline, useReconnect, useSocketEvent } from './socket';

// ---------- API ----------
// Estas chamadas só configuram e consultam. Quem envia as mensagens é o executor do servidor.

export interface AutomationInput {
  name: string;
  description: string | null;
  trigger: AutomationTrigger;
}

/** Corpo de criar etapa: os campos da etapa e, se quiser, a posição em que ela entra (padrão: no fim). */
export type StepCreateInput = AutomationStepInput & { position?: number };
export type StepChanges = Partial<AutomationStepInput>;

export const automationsApi = {
  list: (archived = false) =>
    api<AutomationItem[]>(`/automations${qs({ archived: archived ? 1 : undefined })}`),
  get: (id: number) => api<AutomationItem>(`/automations/${id}`),
  create: (input: AutomationInput) => api<AutomationItem>('/automations', { body: { ...input } }),
  update: (id: number, changes: Partial<AutomationInput>) =>
    api<AutomationItem>(`/automations/${id}`, { method: 'PATCH', body: { ...changes } }),
  setStatus: (id: number, status: AutomationSettableStatus) =>
    api<AutomationItem>(`/automations/${id}/status`, { method: 'PATCH', body: { status } }),
  archive: (id: number) => api<AutomationItem>(`/automations/${id}/archive`, { body: {} }),

  // As operações de etapa devolvem a lista completa, já na ordem nova (criar e excluir mudam as posições).
  steps: (id: number) => api<AutomationStep[]>(`/automations/${id}/steps`),
  createStep: (id: number, input: StepCreateInput) =>
    api<AutomationStep[]>(`/automations/${id}/steps`, { body: { ...input } }),
  updateStep: (id: number, stepId: number, changes: StepChanges) =>
    api<AutomationStep[]>(`/automations/${id}/steps/${stepId}`, { method: 'PATCH', body: { ...changes } }),
  deleteStep: (id: number, stepId: number) =>
    api<AutomationStep[]>(`/automations/${id}/steps/${stepId}`, { method: 'DELETE' }),
  reorderSteps: (id: number, stepIds: number[]) =>
    api<AutomationStep[]>(`/automations/${id}/steps/reorder`, { body: { stepIds } }),

  /** Participações mais recentes dos leads nesta automação (para acompanhar o que o executor faz). */
  runs: (id: number, limit = 30, campaignId?: number) =>
    api<AutomationRunItem[]>(`/automations/${id}/runs${qs({ limit, campaignId })}`),

  // Campanhas: iniciar a automação para os leads de uma lista, pelos números escolhidos. Quem seleciona os leads
  // e envia é o servidor (job do scheduler); estas chamadas comandam e consultam.
  campaigns: (id: number) => api<CampaignItem[]>(`/automations/${id}/campaigns`),
  campaign: (id: number, campaignId: number) =>
    api<CampaignDetail>(`/automations/${id}/campaigns/${campaignId}`),
  /** A prévia é uma consulta (POST só porque leva a configuração inteira no corpo): não cria nada. */
  campaignPreview: (id: number, input: CampaignInput) =>
    api<CampaignPreview>(`/automations/${id}/campaigns/preview`, { body: { ...input } }),
  startCampaign: (id: number, input: CampaignInput) =>
    api<CampaignDetail>(`/automations/${id}/campaigns`, { body: { ...input } }),
  updateCampaign: (id: number, campaignId: number, changes: CampaignUpdateInput) =>
    api<CampaignDetail>(`/automations/${id}/campaigns/${campaignId}`, {
      method: 'PATCH',
      body: { ...changes },
    }),
  campaignStats: (id: number, campaignId: number) =>
    api<CampaignStatsResult>(`/automations/${id}/campaigns/${campaignId}/stats`),
  campaignCalendar: (id: number, campaignId: number, days = 14) =>
    api<CampaignCalendar>(`/automations/${id}/campaigns/${campaignId}/calendar${qs({ days })}`),
  pauseCampaign: (id: number, campaignId: number) =>
    api<CampaignDetail>(`/automations/${id}/campaigns/${campaignId}/pause`, { body: {} }),
  resumeCampaign: (id: number, campaignId: number) =>
    api<CampaignDetail>(`/automations/${id}/campaigns/${campaignId}/resume`, { body: {} }),
  stopCampaign: (id: number, campaignId: number) =>
    api<CampaignDetail>(`/automations/${id}/campaigns/${campaignId}/stop`, { body: {} }),
};

// ---------- cache ----------

export { campaignEndLabel, runReasonLabel } from '../../shared/automations';

/** Mesma chave da tela de Áudios: a biblioteca é uma só, e as duas telas dividem o cache. */
export const AUDIOS_QUERY_KEY = ['wa-audios'] as const;

const LISTS = ['automations'] as const;
export const automationKey = (id: number) => ['automation', id] as const;
export const automationRunsKey = (id: number) => ['automation-runs', id] as const;
export const campaignsKey = (id: number) => ['automation-campaigns', id] as const;
export const campaignKey = (id: number, campaignId: number) =>
  ['automation-campaign', id, campaignId] as const;
export const campaignRunsKey = (id: number, campaignId: number) =>
  ['automation-campaign-runs', id, campaignId] as const;
export const campaignStatsKey = (id: number, campaignId: number) =>
  ['automation-campaign-stats', id, campaignId] as const;
export const campaignCalendarKey = (id: number, campaignId: number) =>
  ['automation-campaign-calendar', id, campaignId] as const;

/** Tudo o que a tela mostra de uma campanha da automação: a próxima consulta busca de novo. */
export function useInvalidateCampaign(automationId: number) {
  const qc = useQueryClient();
  return useCallback(() => {
    for (const key of [
      campaignsKey(automationId),
      ['automation-campaign', automationId],
      ['automation-campaign-runs', automationId],
      ['automation-campaign-stats', automationId],
      ['automation-campaign-calendar', automationId],
      automationRunsKey(automationId),
    ]) {
      void qc.invalidateQueries({ queryKey: key });
    }
  }, [qc, automationId]);
}

/**
 * Tempo real das campanhas: o servidor avisa (só os ids) quando algo muda e a tela busca de novo pela API. Se o tempo real
 * cair, as consultas continuam sendo refeitas devagar (a cada 15 s; com o tempo real de pé, a cada 30 s, só por garantia).
 */
export function useCampaignRealtime(automationId: number): { pollMs: number } {
  const invalidate = useInvalidateCampaign(automationId);
  const online = useRealtimeOnline();
  useSocketEvent<{ automationId: number; campaignId: number }>('campaign:updated', (event) => {
    if (event.automationId === automationId) invalidate();
  });
  useReconnect(invalidate);
  return { pollMs: online ? 30_000 : 15_000 };
}

export function useAutomations(archived: boolean) {
  return useQuery({
    queryKey: [...LISTS, archived],
    queryFn: () => automationsApi.list(archived),
    staleTime: 15_000,
  });
}

export function useAutomation(id: number) {
  return useQuery({ queryKey: automationKey(id), queryFn: () => automationsApi.get(id) });
}

/** Mantém o cache em dia depois de uma mudança, sem buscar de novo o que a resposta já traz. */
export function useAutomationCache() {
  const qc = useQueryClient();
  const refreshLists = useCallback(() => qc.invalidateQueries({ queryKey: LISTS }), [qc]);
  return {
    /** A automação mudou (dados ou situação): grava no cache e atualiza as listas. */
    setAutomation: useCallback(
      (item: AutomationItem) => {
        qc.setQueryData(automationKey(item.id), item);
        void refreshLists();
      },
      [qc, refreshLists],
    ),
    /** As etapas mudaram: a resposta já traz a lista completa e ordenada. */
    setSteps: useCallback(
      (id: number, steps: AutomationStep[]) => {
        qc.setQueryData<AutomationItem>(automationKey(id), (old) => (old ? { ...old, steps } : old));
        void refreshLists();
      },
      [qc, refreshLists],
    ),
    /** Deu erro no meio do caminho: busca de novo, para a tela mostrar o que está de fato salvo. */
    reload: useCallback((id: number) => qc.invalidateQueries({ queryKey: automationKey(id) }), [qc]),
  };
}

// ---------- rótulos ----------

export const STATUS_INFO: Record<
  AutomationStatus,
  { label: string; tone: 'neutral' | 'ok' | 'warn' | 'mute' }
> = {
  draft: { label: 'Rascunho', tone: 'neutral' },
  active: { label: 'Ativa', tone: 'ok' },
  paused: { label: 'Pausada', tone: 'warn' },
  archived: { label: 'Arquivada', tone: 'mute' },
};

export const TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  manual: 'Manual',
  lead_called: 'Quando um lead for chamado',
  lead_created: 'Quando um lead for criado',
};

/** Como cada gatilho funciona (mostrado no editor e ao criar a automação). */
export const TRIGGER_HELP: Record<AutomationTrigger, string> = {
  lead_called:
    'Começa quando um atendente chama um lead pelo botão Chamar e a mensagem inicial sai. Fala pelo mesmo número que fez a chamada.',
  manual:
    'Começa quando um gestor a inicia para um lead (POST /api/automations/:id/run, um lead por pedido). Ainda não há botão para isso na tela.',
  lead_created:
    'Ainda não disponível: leads nascem em importações em massa, e isso não dispara mensagens. Escolha outro gatilho para poder ativar.',
};

/** Situação da participação de um lead (o que o executor está fazendo com ele). */
export const RUN_STATUS_INFO: Record<
  AutomationRunStatus,
  { label: string; tone: 'info' | 'warn' | 'ok' | 'mute' | 'bad' }
> = {
  pending: { label: 'Aguardando', tone: 'info' },
  running: { label: 'Enviando', tone: 'warn' },
  completed: { label: 'Concluída', tone: 'ok' },
  cancelled: { label: 'Cancelada', tone: 'mute' },
  failed: { label: 'Falhou', tone: 'bad' },
};

export const STEP_RUN_LABELS: Record<AutomationStepRunStatus, string> = {
  pending: 'agendada',
  running: 'enviando',
  completed: 'enviada',
  skipped: 'pulada',
  failed: 'falhou',
  cancelled: 'cancelada',
};

export const AUDIO_MODE_LABELS: Record<AutomationAudioMode, string> = {
  fixed: 'Áudio fixo',
  random: 'Sortear entre os áudios ativos',
};

/** Situação da campanha. "Concluída" = acabaram os leads da lista; "Encerrada" = alguém encerrou. */
export const CAMPAIGN_STATUS_INFO: Record<
  CampaignStatus,
  { label: string; tone: 'ok' | 'warn' | 'mute' | 'info' }
> = {
  active: { label: 'Ativa', tone: 'ok' },
  paused: { label: 'Pausada', tone: 'warn' },
  stopped: { label: 'Encerrada', tone: 'mute' },
  finished: { label: 'Concluída', tone: 'ok' },
};

/** "Agendada" não é um estado guardado: é uma campanha ativa cuja data inicial ainda não chegou (conta do servidor). */
export function campaignBadge(c: Pick<CampaignItem, 'status' | 'schedule'>) {
  if (c.status === 'active' && c.schedule.state === 'scheduled') {
    return { label: 'Agendada', tone: 'info' } as const;
  }
  return CAMPAIGN_STATUS_INFO[c.status];
}

export const ACTION_LABELS: Record<AutomationActionType, string> = {
  send_text: 'Enviar mensagem de texto',
  send_audio: 'Enviar áudio',
};

// ---------- espera ----------

export type DelayUnit = 'seconds' | 'minutes' | 'hours' | 'days';

export const DELAY_UNITS: readonly { unit: DelayUnit; label: string; seconds: number }[] = [
  { unit: 'seconds', label: 'segundos', seconds: 1 },
  { unit: 'minutes', label: 'minutos', seconds: 60 },
  { unit: 'hours', label: 'horas', seconds: 3600 },
  { unit: 'days', label: 'dias', seconds: 86_400 },
];

const unitSeconds = (unit: DelayUnit) => DELAY_UNITS.find((u) => u.unit === unit)?.seconds ?? 1;

/** Quantidade + unidade → segundos (é o que fica guardado). */
export function delayToSeconds(value: number, unit: DelayUnit): number {
  return Math.round(value * unitSeconds(unit));
}

/** Segundos → a maior unidade que divide certo (3600 → 1 hora; 5400 → 90 minutos). */
export function splitDelay(seconds: number): { value: number; unit: DelayUnit } {
  if (seconds > 0) {
    for (const { unit, seconds: size } of [...DELAY_UNITS].reverse()) {
      if (seconds % size === 0) return { value: seconds / size, unit };
    }
  }
  return { value: seconds, unit: seconds > 0 ? 'seconds' : 'minutes' };
}

/** A espera cabe no que o banco aceita (0 a 1 ano)? */
export function isValidDelay(seconds: number): boolean {
  return Number.isInteger(seconds) && seconds >= 0 && seconds <= AUTOMATION_MAX_DELAY_SECONDS;
}

/** O que a pessoa digitou (aceita vírgula: "1,5") + a unidade → segundos, ou null se não for válido. */
export function parseDelay(text: string, unit: DelayUnit): number | null {
  const typed = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(typed)) return null;
  const seconds = delayToSeconds(Number(typed), unit);
  return isValidDelay(seconds) ? seconds : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Imediatamente", "30 segundos", "2 horas", "1 dia e 2 horas" (as duas maiores partes). */
export function formatDelay(seconds: number): string {
  if (seconds <= 0) return 'Imediatamente';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts = [
    days && plural(days, 'dia', 'dias'),
    hours && plural(hours, 'hora', 'horas'),
    minutes && plural(minutes, 'minuto', 'minutos'),
    secs && plural(secs, 'segundo', 'segundos'),
  ].filter((p): p is string => !!p);
  return parts.slice(0, 2).join(' e ');
}

// ---------- condições ----------
// Os rótulos e a descrição vêm de src/shared (o servidor usa os mesmos ao explicar uma etapa pulada).
export {
  CONDITION_FIELD_LABELS,
  describeCondition,
  LEAD_STATUS_LABELS,
  OPERATOR_LABELS,
} from '../../shared/automations';

/** Uma condição nova, com um valor inicial que faz sentido para o campo. */
export function newCondition(field: AutomationConditionField, listId?: string): AutomationCondition {
  switch (field) {
    case 'lead_result':
      return { field, operator: 'is', value: 'respondeu' satisfies ResultId };
    case 'lead_replied':
      return { field, operator: 'is', value: true };
    case 'lead_status':
      return { field, operator: 'is', value: 'pendente' };
    case 'lead_list':
      return { field, operator: 'is', value: listId ?? '' };
  }
}

/** A condição está completa (por exemplo, "lista" sem lista escolhida ainda não está)? */
export function isConditionComplete(c: AutomationCondition): boolean {
  return c.field === 'lead_list' ? c.value !== '' : true;
}
