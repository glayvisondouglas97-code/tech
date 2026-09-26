/**
 * Condições de uma etapa (guardadas na Parte 3, interpretadas aqui). Cada uma é `{ field, operator, value }`.
 * Sem condições, a etapa vale. Com várias, todas precisam ser verdadeiras (E). Condição que não dá para
 * entender (campo ou operador desconhecido, dado antigo) conta como NÃO atendida: na dúvida, não envia.
 */
import { AUTOMATION_CONDITION_FIELDS, describeCondition } from '../../../shared/automations';
import type { AutomationCondition } from './types';

/** O que o executor sabe do lead na hora de conferir. */
export interface LeadFacts {
  /** Resultado do último contato (leads.result). */
  result: string | null;
  /** O lead já mandou mensagem na conversa deste número (wa_conversations.lead_replied). */
  replied: boolean;
  /** Situação do lead (pendente, chamado, bloqueado). */
  status: string;
  /** Lista de onde o lead veio. */
  listId: string;
}

function actualValue(
  field: AutomationCondition['field'],
  facts: LeadFacts,
): string | boolean | null | undefined {
  switch (field) {
    case 'lead_result':
      return facts.result;
    case 'lead_replied':
      return facts.replied;
    case 'lead_status':
      return facts.status;
    case 'lead_list':
      return facts.listId;
    default:
      return undefined;
  }
}

export function conditionHolds(condition: AutomationCondition, facts: LeadFacts): boolean {
  if (!(AUTOMATION_CONDITION_FIELDS as readonly string[]).includes(condition.field)) return false;
  if (condition.operator !== 'is' && condition.operator !== 'is_not') return false;
  const equal = actualValue(condition.field, facts) === condition.value;
  return condition.operator === 'is' ? equal : !equal;
}

export interface ConditionsResult {
  passed: boolean;
  /** A primeira condição que não foi atendida, já explicada em português (para o histórico da etapa). */
  failed: string | null;
}

export function evaluateConditions(
  conditions: readonly AutomationCondition[],
  facts: LeadFacts,
  listName?: (id: string) => string | undefined,
): ConditionsResult {
  for (const condition of conditions) {
    if (!conditionHolds(condition, facts))
      return { passed: false, failed: describeCondition(condition, listName) };
  }
  return { passed: true, failed: null };
}
