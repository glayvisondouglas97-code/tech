/** Textos da cota diária de contatos por número. Os números vêm sempre do servidor (`InstanceUsage`). */
import { plural } from './format';

interface Breakdown {
  manual: number;
  automatic: number;
  uncertain: number;
}

/** "7 manuais · 13 automáticos" (e "· 1 incerto" quando há envio em andamento ou de resultado incerto). */
export function usageBreakdown(u: Breakdown): string {
  const parts = [plural(u.manual, 'manual', 'manuais'), plural(u.automatic, 'automático', 'automáticos')];
  if (u.uncertain > 0) parts.push(plural(u.uncertain, 'incerto', 'incertos'));
  return parts.join(' · ');
}

export const LIMIT_REACHED_LABEL = 'Limite diário atingido';
