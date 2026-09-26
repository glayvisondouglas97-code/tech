/**
 * Automações: listas fixas, limites e regras puras usadas pelo servidor (validação) e pela interface
 * (menus e conferência antes de salvar). Nada aqui executa automação: ela só é configurada e guardada.
 */
import type { AutomationCondition, AutomationStep, LeadStatus } from './api';
import { INSTANCE_DAILY_CONTACT_LIMIT } from './quota';
import { RESULTS } from './results';

/** Situação de uma automação. Toda automação nasce como rascunho. */
export const AUTOMATION_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

/** Situações que o gestor escolhe ao ativar ou pausar. Rascunho é a inicial; arquivar tem operação própria. */
export const AUTOMATION_SETTABLE_STATUSES = [
  'active',
  'paused',
] as const satisfies readonly AutomationStatus[];
export type AutomationSettableStatus = (typeof AUTOMATION_SETTABLE_STATUSES)[number];

/** O que dispara uma automação. Por enquanto os gatilhos só são guardados: nenhum é executado. */
export const AUTOMATION_TRIGGERS = ['lead_called', 'lead_created', 'manual'] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

/** Situação da participação de um lead numa automação (preparada para o executor; ainda sem uso). */
export const AUTOMATION_RUN_STATUSES = ['pending', 'running', 'completed', 'cancelled', 'failed'] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

/** Situação de cada tentativa de uma etapa. "skipped" é a etapa cuja condição não foi atendida. */
export const AUTOMATION_STEP_RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'cancelled',
  'failed',
  'skipped',
] as const;
export type AutomationStepRunStatus = (typeof AUTOMATION_STEP_RUN_STATUSES)[number];

/** O que uma etapa faz. */
export const AUTOMATION_ACTION_TYPES = ['send_text', 'send_audio'] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

/**
 * Como uma etapa de áudio escolhe o áudio: `fixed` = o áudio que o gestor escolheu; `random` = rodízio entre os áudios
 * ativos da biblioteca (sorteio em "saco embaralhado": todos saem uma vez antes de qualquer um repetir, e o mesmo
 * áudio nunca sai duas vezes seguidas).
 */
export const AUTOMATION_AUDIO_MODES = ['fixed', 'random'] as const;
export type AutomationAudioMode = (typeof AUTOMATION_AUDIO_MODES)[number];

/**
 * Condições de uma etapa, guardadas em `automation_steps.conditions` (JSON): cada uma é
 * `{ field, operator, value }`. O tipo do valor depende do campo (ver `AutomationCondition`).
 * Por enquanto só são guardadas; quem interpreta é o executor.
 */
export const AUTOMATION_CONDITION_FIELDS = [
  'lead_result',
  'lead_replied',
  'lead_status',
  'lead_list',
] as const;
export type AutomationConditionField = (typeof AUTOMATION_CONDITION_FIELDS)[number];

export const AUTOMATION_CONDITION_OPERATORS = ['is', 'is_not'] as const;
export type AutomationConditionOperator = (typeof AUTOMATION_CONDITION_OPERATORS)[number];

/** Situações do lead (as mesmas de `LeadStatus`). */
export const LEAD_STATUSES = ['pendente', 'chamado', 'bloqueado'] as const satisfies readonly LeadStatus[];

// ---------- limites (os mesmos das colunas do banco) ----------

export const AUTOMATION_NAME_MAX = 80;
export const AUTOMATION_DESCRIPTION_MAX = 500;
/** Texto de uma etapa: o mesmo limite do envio de mensagem de texto. */
export const AUTOMATION_MESSAGE_MAX = 4096;
/** Espera de uma etapa: até 1 ano, em segundos. 0 = imediatamente. */
export const AUTOMATION_MAX_DELAY_SECONDS = 31_536_000;
export const AUTOMATION_MAX_STEPS = 20;
export const AUTOMATION_MAX_CONDITIONS = 10;

// ---------- variáveis das mensagens ----------

/**
 * Variáveis que a mensagem pode usar, escritas como {{nome}}. Por enquanto só são guardadas no texto;
 * quem troca pelos dados do lead é o executor.
 */
export const AUTOMATION_VARIABLES = [
  { name: 'nome', label: 'Nome do contato' },
  { name: 'empresa', label: 'Empresa do lead' },
  { name: 'telefone', label: 'Telefone do lead' },
  { name: 'atendente', label: 'Atendente que chamou' },
  { name: 'numero', label: 'Número de WhatsApp usado' },
] as const;

const KNOWN_VARIABLES: ReadonlySet<string> = new Set(AUTOMATION_VARIABLES.map((v) => v.name));

/** Variáveis {{...}} do texto que não existem (provável erro de digitação), sem repetir. */
export function unknownVariables(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const name = match[1] ?? '';
    if (!KNOWN_VARIABLES.has(name)) found.add(name);
  }
  return [...found];
}

// ---------- conferência das etapas ----------

type StepShape = Pick<AutomationStep, 'actionType' | 'messageText' | 'audioId'> & {
  audioMode?: AutomationAudioMode;
};

/** O que falta para a etapa estar completa (null = completa). */
export function stepProblem(step: StepShape): string | null {
  if (step.actionType === 'send_text' && !step.messageText?.trim()) return 'escreva a mensagem.';
  // No modo sorteio não há áudio fixo: o áudio é escolhido entre os ativos da biblioteca na hora do envio.
  if (step.actionType === 'send_audio' && step.audioMode !== 'random' && step.audioId == null) {
    return 'escolha o áudio.';
  }
  return null;
}

/** O que impede de ativar a automação (lista vazia = pode ativar). As etapas vêm na ordem. */
export function automationProblems(steps: readonly (StepShape & { position: number })[]): string[] {
  if (!steps.length) return ['Adicione pelo menos uma etapa.'];
  const problems: string[] = [];
  for (const step of steps) {
    const problem = stepProblem(step);
    if (problem) problems.push(`Etapa ${step.position}: ${problem}`);
  }
  return problems;
}

// ---------- motivos de cancelamento e de falha ----------

/**
 * Motivos guardados em `automation_runs.cancel_reason` (cancelada ou com falha). O texto de cada etapa
 * fica em `automation_step_runs.error`.
 */
export const RUN_REASON_LABELS: Record<string, string> = {
  // canceladas
  lead_respondeu: 'O lead respondeu',
  automacao_arquivada: 'A automação foi arquivada',
  lead_bloqueado: 'O telefone está em "não contatar"',
  lead_anonimizado: 'O lead foi anonimizado (LGPD)',
  lead_removido: 'O lead foi excluído',
  numero_removido: 'O número de WhatsApp foi excluído',
  // com falha
  executor_interrompido: 'O servidor parou no meio do envio (a mensagem NÃO foi reenviada)',
  etapa_invalida: 'A etapa está incompleta',
  variavel_desconhecida: 'A mensagem tem uma variável que não existe',
  audio_indisponivel: 'O áudio da etapa não está disponível',
  sem_whatsapp: 'O telefone do lead não tem WhatsApp',
  conversa_ambigua: 'Há mais de uma conversa deste lead neste número',
  envio_recusado: 'A Evolution recusou o envio',
  resultado_incerto: 'Não foi possível saber se a mensagem foi enviada (não foi reenviada)',
  tentativas_esgotadas: 'Número desconectado: as tentativas acabaram',
  erro_interno: 'Erro inesperado no servidor',
  // campanhas
  campanha_encerrada: 'A campanha foi encerrada',
  lista_removida: 'A lista da campanha foi removida',
  lista_arquivada: 'A lista da campanha foi arquivada',
  data_final: 'A campanha passou da data final',
  lead_indisponivel: 'O lead foi atendido por outra via antes do envio',
  lista_esgotada: 'Todos os leads da lista já foram atendidos',
};

export const runReasonLabel = (reason: string | null): string | null =>
  reason ? (RUN_REASON_LABELS[reason] ?? reason) : null;

// ---------- descrição das condições ----------

export const CONDITION_FIELD_LABELS: Record<AutomationConditionField, string> = {
  lead_result: 'Resultado do lead',
  lead_replied: 'Lead respondeu',
  lead_status: 'Situação do lead',
  lead_list: 'Lista do lead',
};

export const OPERATOR_LABELS = { is: 'é', is_not: 'não é' } as const;

export const LEAD_STATUS_LABELS: Record<(typeof LEAD_STATUSES)[number], string> = {
  pendente: 'Pendente (na fila)',
  chamado: 'Chamado',
  bloqueado: 'Bloqueado (não contatar)',
};

const resultLabel = (id: string) => RESULTS.find((r) => r.id === id)?.label ?? id;

/** "Resultado do lead é Respondeu", "Lead respondeu é Sim", "Lista do lead é Clientes de setembro". */
export function describeCondition(
  c: AutomationCondition,
  listName?: (id: string) => string | undefined,
): string {
  const value = (() => {
    switch (c.field) {
      case 'lead_result':
        return resultLabel(c.value);
      case 'lead_replied':
        return c.value ? 'Sim' : 'Não';
      case 'lead_status':
        return LEAD_STATUS_LABELS[c.value] ?? c.value;
      case 'lead_list':
        return listName?.(c.value) ?? 'lista removida';
      default:
        return String((c as { value?: unknown }).value);
    }
  })();
  const field = CONDITION_FIELD_LABELS[c.field] ?? String((c as { field?: unknown }).field);
  return `${field} ${OPERATOR_LABELS[c.operator] ?? c.operator} ${value}`;
}

// ---------- campanhas ----------

/** Situação de uma campanha. "stopped" = encerrada por alguém; "finished" = acabaram os leads da lista. */
export const CAMPAIGN_STATUSES = ['active', 'paused', 'stopped', 'finished'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Fuso do sistema: o dia dos limites e a janela de horário são sempre os de São Paulo. */
export const CAMPAIGN_TIMEZONE = 'America/Sao_Paulo';

/** Valores iniciais do formulário: das 10:00 às 16:00, 20 leads novos por número por dia. */
export const CAMPAIGN_DEFAULTS = {
  windowStart: '10:00',
  windowEnd: '16:00',
  dailyLimitPerNumber: 20,
} as const;
/** Teto que uma campanha pode escolher por número: nunca mais que o limite diário de contatos de qualquer número (20). */
export const CAMPAIGN_MAX_DAILY_LIMIT = INSTANCE_DAILY_CONTACT_LIMIT;
export const CAMPAIGN_MAX_NUMBERS = 20;

/** Por que uma campanha terminou (guardado em `automation_campaigns.end_reason`). */
export const CAMPAIGN_END_LABELS: Record<string, string> = {
  encerrada_manualmente: 'Encerrada por uma pessoa',
  lista_esgotada: 'Todos os leads da lista já foram atendidos',
  lista_removida: 'A lista da campanha foi removida',
  lista_arquivada: 'A lista da campanha foi arquivada',
  data_final: 'Chegou a data final da campanha',
  automacao_arquivada: 'A automação foi arquivada',
};

export const campaignEndLabel = (reason: string | null): string | null =>
  reason ? (CAMPAIGN_END_LABELS[reason] ?? reason) : null;

/** "10:00" → 600 (minutos desde a meia-noite). null se não for um horário válido. */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) return null;
  return hours * 60 + minutes;
}

/** 600 → "10:00". */
export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
