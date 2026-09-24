import type { Kysely } from 'kysely';
import type { Database } from '../db/schema';

export interface AuditEntry {
  userId: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | number | null;
  details?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Registro de acesso e de ações sensíveis (LGPD).
 * Guarda quem fez, o quê e quando. Não guarda nome nem telefone de leads nos detalhes.
 */
export async function audit(db: Kysely<Database>, e: AuditEntry): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      user_id: e.userId,
      action: e.action,
      entity: e.entity ?? null,
      entity_id: e.entityId == null ? null : String(e.entityId),
      details: JSON.stringify(e.details ?? {}),
      ip: e.ip ?? null,
    })
    .execute();
}

/** Mascara um telefone para registros: 5541998765432 → +55 41 9****-5432. */
export function maskPhone(phone: string): string {
  const d = String(phone).replace(/\D/g, '');
  if (d.length < 8) return '****';
  return `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 5)}****-${d.slice(-4)}`;
}
