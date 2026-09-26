/**
 * Cota diária de contatos de cada número de WhatsApp. Regra oficial: no máximo 20 CONTATOS NOVOS por número por dia
 * (fuso de São Paulo), somando os contatos MANUAIS (botão Chamar) e os AUTOMÁTICOS (campanhas). Reservar um lead
 * para depois NÃO é contato: só conta o que foi efetivamente enviado no dia do envio.
 *
 * É uma regra de controle operacional. Ela NÃO garante que o WhatsApp não bloqueie o número.
 */

/** Contatos novos por número por dia. Também é a trava do banco (`wa_instance_daily_usage_max`). */
export const INSTANCE_DAILY_CONTACT_LIMIT = 20;

/** Como o dia de um número está sendo usado (só o que foi enviado; `uncertain` inclui o envio em andamento). */
export interface InstanceUsage {
  /** AAAA-MM-DD em São Paulo. */
  date: string;
  manual: number;
  automatic: number;
  /** Envio em andamento ou de resultado incerto: a vaga fica ocupada (nunca é liberada às cegas). */
  uncertain: number;
  /** manual + automático + incerto. */
  total: number;
  /** O teto que vale para quem pergunta (20, ou o teto menor de uma campanha). */
  limit: number;
  remaining: number;
  limitReached: boolean;
}

export function usageOf(
  row: { manual: number; automatic: number; uncertain: number } | null | undefined,
  date: string,
  limit: number = INSTANCE_DAILY_CONTACT_LIMIT,
): InstanceUsage {
  const manual = row?.manual ?? 0;
  const automatic = row?.automatic ?? 0;
  const uncertain = row?.uncertain ?? 0;
  const total = manual + automatic + uncertain;
  const cap = Math.max(1, Math.min(limit, INSTANCE_DAILY_CONTACT_LIMIT));
  return {
    date,
    manual,
    automatic,
    uncertain,
    total,
    limit: cap,
    remaining: Math.max(0, cap - total),
    limitReached: total >= cap,
  };
}

export const contactLimitMessage = (limit: number = INSTANCE_DAILY_CONTACT_LIMIT): string =>
  `Este número já atingiu o limite de ${limit} contatos hoje.`;
