/**
 * Tipos internos do módulo de automações. Os formatos que também aparecem na API vêm de `src/shared`
 * (uma definição só, usada pelo servidor e pela interface); aqui ficam os de uso exclusivo do servidor.
 */
import type { AutomationTrigger } from '../../../shared/automations';

export type {
  AutomationCondition,
  AutomationItem,
  AutomationStep,
  AutomationStepInput,
} from '../../../shared/api';
export type {
  AutomationActionType,
  AutomationConditionField,
  AutomationConditionOperator,
  AutomationSettableStatus,
  AutomationStatus,
  AutomationTrigger,
} from '../../../shared/automations';

/** Dados para criar uma automação (já validados). Ela nasce como rascunho e sem etapas. */
export interface NewAutomation {
  name: string;
  /** null = sem descrição. */
  description: string | null;
  trigger: AutomationTrigger;
}

/** Alterações de uma automação: só os campos enviados mudam (as etapas têm operações próprias). */
export type AutomationChanges = Partial<NewAutomation>;
