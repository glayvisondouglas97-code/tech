/**
 * O lead ainda pode receber mensagem automática? Reaproveita as regras que o sistema já tem:
 * "não contatar" (`blocked_phones`, e o lead marcado como bloqueado, que é o que o opt-out e o bloqueio
 * fazem), anonimização (LGPD) e lead excluído (as chaves estrangeiras apagam as participações).
 * Usado ao iniciar uma participação e, de novo, ANTES DE CADA ENVIO: o lead pode ter mudado no meio do caminho.
 */
import type { Db } from '../../db';
import type { Lead } from '../../db/schema';
import { REASON } from './runs';

export type LeadForRun = Pick<
  Lead,
  'id' | 'name' | 'company' | 'phone' | 'status' | 'result' | 'list_id' | 'called_by' | 'assigned_to'
>;

export type Ineligible = 'lead_removido' | typeof REASON.anonymized | typeof REASON.blocked;

export const INELIGIBLE_MESSAGES: Record<Ineligible, string> = {
  lead_removido: 'Lead não encontrado.',
  lead_anonimizado: 'Este lead foi anonimizado.',
  lead_bloqueado: 'Este número está na lista de não contatar.',
};

export async function leadEligibility(
  db: Db,
  leadId: number,
): Promise<{ lead: LeadForRun } | { reason: Ineligible }> {
  const lead = await db
    .selectFrom('leads')
    .select([
      'id',
      'name',
      'company',
      'phone',
      'status',
      'result',
      'list_id',
      'called_by',
      'assigned_to',
      'anonymized_at',
    ])
    .where('id', '=', leadId)
    .executeTakeFirst();
  if (!lead) return { reason: 'lead_removido' };
  if (lead.anonymized_at || !lead.phone) return { reason: REASON.anonymized };
  if (lead.status === 'bloqueado') return { reason: REASON.blocked };
  const blocked = await db
    .selectFrom('blocked_phones')
    .select('phone')
    .where('phone', '=', lead.phone)
    .executeTakeFirst();
  if (blocked) return { reason: REASON.blocked };
  const { anonymized_at: _anonymized, ...rest } = lead;
  return { lead: rest };
}
