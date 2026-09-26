import { z } from 'zod';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_AUDIO_MODES,
  AUTOMATION_CONDITION_FIELDS,
  AUTOMATION_CONDITION_OPERATORS,
  AUTOMATION_DESCRIPTION_MAX,
  AUTOMATION_MAX_CONDITIONS,
  AUTOMATION_MAX_DELAY_SECONDS,
  AUTOMATION_MAX_STEPS,
  AUTOMATION_MESSAGE_MAX,
  AUTOMATION_NAME_MAX,
  AUTOMATION_SETTABLE_STATUSES,
  AUTOMATION_TRIGGERS,
  CAMPAIGN_DEFAULTS,
  CAMPAIGN_MAX_DAILY_LIMIT,
  CAMPAIGN_MAX_NUMBERS,
  LEAD_STATUSES,
  parseClock,
} from '../../../shared/automations';
import {
  CALLED_BEFORE_OPTIONS,
  CAMPAIGN_LEAD_STATUSES,
  CAMPAIGN_PHONE_TYPES,
  COOLDOWN_DEFAULT_HOURS,
  COOLDOWN_MAX_HOURS,
  DEFAULT_DAYS,
  MAX_FILTER_DDDS,
  normalizeDays,
  normalizeFilters,
} from '../../../shared/campaign-plan';
import { RESULT_IDS } from '../../../shared/results';
import { notFound } from '../../lib/errors';
import type { AutomationCondition } from './types';

const name = z.string().trim().min(1).max(AUTOMATION_NAME_MAX);
// Vazio ou ausente vira null (sem descrição).
const description = z
  .string()
  .trim()
  .max(AUTOMATION_DESCRIPTION_MAX)
  .nullish()
  .transform((v) => v || null);
const trigger = z.enum(AUTOMATION_TRIGGERS);

/** Listar: por padrão sem as arquivadas (?archived=1 mostra só as arquivadas), como em /lists. */
export const automationListSchema = z.object({ archived: z.enum(['0', '1']).default('0') });

/** Criar: só o nome é obrigatório. Sem gatilho escolhido, fica "manual" (nada dispara sozinho). */
export const automationCreateSchema = z.object({
  name,
  description,
  trigger: trigger.default('manual'),
});

/** Atualizar: manda-se só o que muda, mas pelo menos um campo. Descrição vazia apaga a descrição. */
export const automationUpdateSchema = z
  .object({ name, description, trigger })
  .partial()
  .refine((changes) => Object.keys(changes).length > 0, 'nenhum campo para alterar');

/** Ativar ou pausar. Arquivar é `POST /automations/:id/archive`. */
export const automationStatusSchema = z.object({ status: z.enum(AUTOMATION_SETTABLE_STATUSES) });

const idSchema = z.coerce.number().int().positive();

/** Id da rota. Um id que não é número válido responde 404, como o de lead. */
export function parseAutomationId(raw: unknown): number {
  const r = idSchema.safeParse(raw);
  if (!r.success) throw notFound('Automação não encontrada.');
  return r.data;
}

/** Id de etapa da rota: inválido também responde 404. */
export function parseStepId(raw: unknown): number {
  const r = idSchema.safeParse(raw);
  if (!r.success) throw notFound('Etapa não encontrada.');
  return r.data;
}

// ---------- etapas ----------

/**
 * Condição de uma etapa. Só é conferida e guardada; o executor a interpreta mais tarde.
 * O tipo do valor depende do campo: resultado e situação do lead (das listas do sistema), respondeu
 * (sim/não) e a lista de onde o lead veio (o id).
 */
const conditionSchema = z
  .object({
    field: z.enum(AUTOMATION_CONDITION_FIELDS),
    operator: z.enum(AUTOMATION_CONDITION_OPERATORS),
    value: z.union([z.string().max(60), z.boolean()]),
  })
  .strict()
  .superRefine((c, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', path: ['value'], message });
    switch (c.field) {
      case 'lead_result':
        if (typeof c.value !== 'string' || !(RESULT_IDS as string[]).includes(c.value)) {
          invalid('escolha um resultado que exista');
        }
        break;
      case 'lead_status':
        if (typeof c.value !== 'string' || !(LEAD_STATUSES as readonly string[]).includes(c.value)) {
          invalid('escolha uma situação que exista');
        }
        break;
      case 'lead_replied':
        if (typeof c.value !== 'boolean') invalid('escolha sim ou não');
        break;
      case 'lead_list':
        if (typeof c.value !== 'string' || !z.string().uuid().safeParse(c.value).success) {
          invalid('escolha uma lista');
        }
        break;
    }
  })
  .transform((c) => c as AutomationCondition);

const conditions = z.array(conditionSchema).max(AUTOMATION_MAX_CONDITIONS);
const delaySeconds = z.number().int().min(0).max(AUTOMATION_MAX_DELAY_SECONDS);
const messageText = z.string().trim().min(1).max(AUTOMATION_MESSAGE_MAX);
const audioId = z.number().int().positive();

const stepFields = {
  actionType: z.enum(AUTOMATION_ACTION_TYPES),
  delaySeconds,
  messageText: messageText.nullish(),
  audioId: audioId.nullish(),
  audioMode: z.enum(AUTOMATION_AUDIO_MODES).optional(),
  conditions,
};

/**
 * Criar etapa. `position` é onde ela entra (as seguintes descem); sem ele, vai para o fim.
 * Texto e áudio: a etapa de texto precisa da mensagem e a de áudio precisa do áudio.
 */
export const stepCreateSchema = z
  .object({ position: z.number().int().min(1).max(AUTOMATION_MAX_STEPS).optional(), ...stepFields })
  .superRefine((step, ctx) => {
    if (step.actionType === 'send_text' && !step.messageText) {
      ctx.addIssue({ code: 'custom', path: ['messageText'], message: 'escreva a mensagem que será enviada' });
    }
    // No modo sorteio não se escolhe áudio: ele sai do rodízio dos áudios ativos da biblioteca.
    if (step.actionType === 'send_audio' && step.audioMode !== 'random' && step.audioId == null) {
      ctx.addIssue({ code: 'custom', path: ['audioId'], message: 'escolha o áudio que será enviado' });
    }
  })
  .transform((step) => ({
    position: step.position,
    actionType: step.actionType,
    delaySeconds: step.delaySeconds,
    // Cada tipo guarda só o que é dele: a etapa de áudio não leva texto e a de texto não leva áudio.
    messageText: step.actionType === 'send_text' ? (step.messageText ?? null) : null,
    audioMode: (step.actionType === 'send_audio' && step.audioMode === 'random' ? 'random' : 'fixed') as
      | 'fixed'
      | 'random',
    audioId: step.actionType === 'send_audio' && step.audioMode !== 'random' ? (step.audioId ?? null) : null,
    conditions: step.conditions,
  }));

/**
 * Alterar etapa: manda-se só o que muda (pelo menos um campo). A posição não muda aqui (ver reordenar).
 * O que fica faltando é conferido no serviço, junto com o que a etapa já tem.
 */
export const stepUpdateSchema = z
  .object(stepFields)
  .partial()
  .refine((changes) => Object.keys(changes).length > 0, 'nenhum campo para alterar');

/** Reordenar: a lista com os ids de TODAS as etapas na nova ordem. */
export const stepReorderSchema = z.object({
  stepIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(AUTOMATION_MAX_STEPS)
    .refine((ids) => new Set(ids).size === ids.length, 'há etapas repetidas'),
});

export type NewStepInput = z.infer<typeof stepCreateSchema>;
export type StepChangesInput = z.infer<typeof stepUpdateSchema>;

// ---------- execução ----------

/** Iniciar uma automação manualmente: um lead e o número de WhatsApp pelo qual falar. */
export const manualRunSchema = z.object({
  leadId: z.number().int().positive(),
  instanceId: z.number().int().positive(),
});

/** Participações recentes (diagnóstico). Com `campaignId`, só as de uma campanha. */
export const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(30),
  campaignId: z.coerce.number().int().positive().optional(),
});

// ---------- campanhas ----------

const clock = z
  .string()
  .trim()
  .refine((v) => parseClock(v) !== null, 'use o formato HH:MM');
const instanceIds = z
  .array(z.number().int().positive())
  .min(1, 'escolha pelo menos um número')
  .max(CAMPAIGN_MAX_NUMBERS)
  .refine((ids) => new Set(ids).size === ids.length, 'há números repetidos');
const dailyLimit = z.number().int().min(1).max(CAMPAIGN_MAX_DAILY_LIMIT);

/** Data do calendário (AAAA-MM-DD) que existe de verdade (nada de 31/02). */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'use o formato AAAA-MM-DD')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const parsed = new Date(Date.UTC(y, m - 1, d));
    return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
  }, 'data inválida');

/** Dias da semana (1 = segunda ... 7 = domingo), sem repetir. */
const weekdays = z
  .array(z.number().int().min(1).max(7))
  .min(1, 'escolha pelo menos um dia da semana')
  .max(7)
  .transform((days) => normalizeDays(days));

/**
 * Filtros do público. Só dados que já existem no lead; `.strict()` recusa filtro que não existe. O que fica guardado é
 * normalizado (sem listas vazias, sem "tanto faz").
 */
const filtersSchema = z
  .object({
    ddd: z.array(z.string().regex(/^\d{2}$/, 'DDD com dois dígitos')).max(MAX_FILTER_DDDS),
    status: z.array(z.enum(CAMPAIGN_LEAD_STATUSES)),
    result: z.array(z.enum(RESULT_IDS)),
    phoneType: z.array(z.enum(CAMPAIGN_PHONE_TYPES)),
    calledBefore: z.enum(CALLED_BEFORE_OPTIONS),
  })
  .partial()
  .strict()
  .transform((filters) => normalizeFilters(filters));

const campaignFields = {
  listId: z.string().uuid(),
  instanceIds,
  windowStart: clock.default(CAMPAIGN_DEFAULTS.windowStart),
  windowEnd: clock.default(CAMPAIGN_DEFAULTS.windowEnd),
  dailyLimitPerNumber: dailyLimit.default(CAMPAIGN_DEFAULTS.dailyLimitPerNumber),
  startDate: calendarDate.optional(),
  endDate: calendarDate.nullish(),
  daysOfWeek: weekdays.default([...DEFAULT_DAYS]),
  cooldownHours: z.number().int().min(0).max(COOLDOWN_MAX_HOURS).default(COOLDOWN_DEFAULT_HOURS),
  filters: filtersSchema.default({}),
};

const validWindow = (c: { windowStart?: string; windowEnd?: string }) => {
  if (c.windowStart === undefined || c.windowEnd === undefined) return true;
  const start = parseClock(c.windowStart);
  const end = parseClock(c.windowEnd);
  return start !== null && end !== null && start < end && start <= 1439 && end >= 1;
};
const validDates = (c: { startDate?: string | null; endDate?: string | null }) =>
  !c.startDate || !c.endDate || c.endDate >= c.startDate;

/**
 * Iniciar (ou agendar) uma campanha: a lista, os números, o horário de trabalho, o limite de contatos por número por dia
 * (no máximo 20), as datas, os dias da semana, o cooldown e os filtros do público. Também é o corpo da prévia.
 */
export const campaignCreateSchema = z
  .object(campaignFields)
  .refine(validWindow, { path: ['windowEnd'], message: 'o fim do horário precisa ser depois do início' })
  .refine(validDates, { path: ['endDate'], message: 'a data final não pode ser antes da inicial' });

/** Alterar uma campanha: manda-se só o que muda (pelo menos um campo). */
export const campaignUpdateSchema = z
  .object({
    listId: campaignFields.listId,
    instanceIds,
    windowStart: clock,
    windowEnd: clock,
    dailyLimitPerNumber: dailyLimit,
    startDate: calendarDate,
    endDate: calendarDate.nullable(),
    daysOfWeek: weekdays,
    cooldownHours: campaignFields.cooldownHours,
    filters: filtersSchema,
  })
  .partial()
  .refine((c) => Object.keys(c).length > 0, 'nenhum campo para alterar')
  .refine(validWindow, { path: ['windowEnd'], message: 'o fim do horário precisa ser depois do início' })
  .refine(validDates, { path: ['endDate'], message: 'a data final não pode ser antes da inicial' });

/** Quantos dias o calendário mostra (padrão 14). */
export const calendarQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(60).default(14) });

/** Id de campanha da rota: inválido também responde 404. */
export function parseCampaignId(raw: unknown): number {
  const r = idSchema.safeParse(raw);
  if (!r.success) throw notFound('Campanha não encontrada.');
  return r.data;
}
