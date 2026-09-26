/**
 * Cota diária de contatos de cada número de WhatsApp: a ÚNICA regra, usada pelo botão Chamar (manual) e pelas campanhas
 * (automático). Nenhum dos dois duplica a conta; os dois chamam as funções deste arquivo.
 *
 * RESERVA x USO (o ponto que mais importa):
 * - RESERVA é planejamento: a campanha escolhe um lead e marca quando ele deve sair (`automation_runs.next_run_at`,
 *   `slot_date`). Isso NÃO consome cota.
 * - USO é contato efetivo: a primeira mensagem saiu (ou pode ter saído) por aquele número naquele dia. Só isso está na
 *   tabela `wa_instance_daily_usage`, no dia de São Paulo em que o envio ACONTECEU. Um lead reservado às 15:59 e enviado
 *   no dia seguinte consome a cota do dia seguinte.
 *
 * COMO A VAGA É PROTEGIDA (nada em memória; tudo no PostgreSQL):
 * 1. `claimContactQuota` segura uma vaga ANTES da chamada à Evolution com um único comando
 *    (`INSERT ... ON CONFLICT DO UPDATE ... WHERE total < limite`). O banco trava a linha do número no dia: dois
 *    processos, dois workers, o atendente e a campanha ao mesmo tempo nunca pegam a mesma última vaga. Além disso a
 *    tabela tem `CHECK (total_contacts <= 20)`: nem um bug passaria o 20.
 * 2. A vaga segurada fica como INCERTA (`uncertain_contacts`): ocupa a cota, mas ainda não é manual nem automático.
 * 3. Envio confirmado  → `confirmContactQuota`: incerto vira manual/automático (o total não muda).
 *    Envio que SABIDAMENTE não saiu (recusa 4xx, número desconectado, antes de chamar a Evolution)
 *                       → `releaseContactQuota`: a vaga volta.
 *    Resultado incerto (5xx, timeout, queda do processo) → a vaga FICA ocupada como incerta. Nunca se libera uma vaga
 *    que pode ter sido gasta: a política é não passar do limite, mesmo que isso deixe uma vaga sem uso no dia.
 *
 * Esta regra é controle operacional. Ela não garante que o WhatsApp não bloqueie o número.
 */
import { sql } from 'kysely';
import {
  contactLimitMessage,
  INSTANCE_DAILY_CONTACT_LIMIT,
  type InstanceUsage,
  usageOf,
} from '../../../shared/quota';
import type { Db } from '../../db';
import { audit } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import { spDate } from '../automations/window';
import { EvolutionError } from './evolution';
import { publishInstance } from './realtime';

export type ContactKind = 'manual' | 'automatic';

/** Uma vaga segurada: quem a segurou precisa confirmá-la ou devolvê-la (ou deixá-la incerta). */
export interface QuotaClaim {
  instanceId: number;
  /** Dia (São Paulo) em que a vaga foi segurada: é nele que ela é confirmada ou devolvida. */
  date: string;
}

/** O dia da cota é sempre o de São Paulo. */
export const quotaDate = (now: Date = new Date()): string => spDate(now);

/** O teto que vale: no máximo 20, e uma campanha pode escolher um teto MENOR. */
export const effectiveLimit = (limit?: number | null): number =>
  Math.max(1, Math.min(limit ?? INSTANCE_DAILY_CONTACT_LIMIT, INSTANCE_DAILY_CONTACT_LIMIT));

interface UsageRow {
  instance_id: number;
  manual: number;
  automatic: number;
  uncertain: number;
}

/** O uso de cada número num dia (número sem linha = 0). Uma consulta só, para quantos números forem. */
export async function instanceUsage(
  db: Db,
  instanceIds: readonly number[],
  date: string,
  limit?: number | null,
): Promise<Map<number, InstanceUsage>> {
  const usage = new Map<number, InstanceUsage>(
    instanceIds.map((id) => [id, usageOf(null, date, effectiveLimit(limit))]),
  );
  if (!instanceIds.length) return usage;
  const rows = await sql<UsageRow>`
    SELECT instance_id, manual_contacts AS manual, automatic_contacts AS automatic, uncertain_contacts AS uncertain
    FROM wa_instance_daily_usage
    WHERE usage_date = ${date}::date AND instance_id = ANY(${[...instanceIds]}::int[])`.execute(db);
  for (const row of rows.rows) usage.set(row.instance_id, usageOf(row, date, effectiveLimit(limit)));
  return usage;
}

/** Só olha (não segura vaga): serve para avisar cedo, planejar a campanha e mostrar na tela. */
export async function checkInstanceDailyQuota(
  db: Db,
  instanceId: number,
  date: string,
  limit?: number | null,
): Promise<{ ok: boolean; usage: InstanceUsage }> {
  const usage = (await instanceUsage(db, [instanceId], date, limit)).get(instanceId) as InstanceUsage;
  return { ok: !usage.limitReached, usage };
}

/** Só os números que ainda têm vaga hoje (número cheio fica fora do rodízio até o dia seguinte). */
export function poolWithCapacity(
  instanceIds: readonly number[],
  usage: ReadonlyMap<number, Pick<InstanceUsage, 'total'>>,
  limit?: number | null,
): number[] {
  const cap = effectiveLimit(limit);
  return instanceIds.filter((id) => (usage.get(id)?.total ?? 0) < cap);
}

/**
 * Segura UMA vaga do dia para um envio que vai acontecer agora. Atômico: devolve `null` se o número já está no
 * limite. Quem chama DEVE depois confirmar (`confirmContactQuota`), devolver (`releaseContactQuota`, só se a mensagem
 * sabidamente não saiu) ou deixar como está (resultado incerto).
 */
export async function claimContactQuota(
  db: Db,
  instanceId: number,
  date: string,
  limit?: number | null,
): Promise<QuotaClaim | null> {
  const cap = effectiveLimit(limit);
  const claimed = await sql<{ total: number }>`
    INSERT INTO wa_instance_daily_usage AS u (instance_id, usage_date, uncertain_contacts, total_contacts)
    VALUES (${instanceId}, ${date}::date, 1, 1)
    ON CONFLICT (instance_id, usage_date) DO UPDATE
      SET uncertain_contacts = u.uncertain_contacts + 1,
          total_contacts = u.total_contacts + 1,
          updated_at = now()
      WHERE u.total_contacts < ${cap}
    RETURNING u.total_contacts AS total`.execute(db);
  return claimed.rows.length ? { instanceId, date } : null;
}

/** O envio foi aceito: a vaga incerta vira contato manual ou automático (o total não muda). */
export async function confirmContactQuota(
  db: Db,
  claim: QuotaClaim,
  kind: ContactKind,
): Promise<InstanceUsage | null> {
  const column = sql.ref(kind === 'manual' ? 'manual_contacts' : 'automatic_contacts');
  const updated = await sql<UsageRow>`
    UPDATE wa_instance_daily_usage
    SET uncertain_contacts = uncertain_contacts - 1, ${column} = ${column} + 1, updated_at = now()
    WHERE instance_id = ${claim.instanceId} AND usage_date = ${claim.date}::date AND uncertain_contacts > 0
    RETURNING instance_id, manual_contacts AS manual, automatic_contacts AS automatic, uncertain_contacts AS uncertain`.execute(
    db,
  );
  const row = updated.rows[0];
  return row ? usageOf(row, claim.date) : null;
}

/** A mensagem SABIDAMENTE não saiu: a vaga volta para o dia. Nunca use isto para resultado incerto. */
export async function releaseContactQuota(db: Db, claim: QuotaClaim): Promise<void> {
  await sql`
    UPDATE wa_instance_daily_usage
    SET uncertain_contacts = uncertain_contacts - 1, total_contacts = total_contacts - 1, updated_at = now()
    WHERE instance_id = ${claim.instanceId} AND usage_date = ${claim.date}::date
      AND uncertain_contacts > 0 AND total_contacts > 0`.execute(db);
}

/**
 * A mensagem não saiu com certeza? Só a RECUSA clara da Evolution (4xx) prova isso. Erro do servidor (5xx), demora,
 * queda de conexão ou qualquer outro erro depois de chamar o envio deixam a dúvida: a vaga fica ocupada.
 */
export function sendDefinitelyFailed(error: unknown): boolean {
  return error instanceof EvolutionError && error.status >= 400 && error.status < 500;
}

export const limitReachedError = (limit?: number | null): AppError =>
  new AppError(409, contactLimitMessage(effectiveLimit(limit)), 'limite_numero');

/**
 * Primeiro contato: a conversa não tem NENHUMA mensagem ainda (nem enviada, nem recebida). Responder a quem escreveu
 * primeiro, ou continuar uma conversa que já existia, não é contato novo e nunca é barrado pela cota.
 */
export async function isFirstContact(db: Db, conversationId: number): Promise<boolean> {
  const any = await db
    .selectFrom('wa_messages')
    .select('id')
    .where('conversation_id', '=', conversationId)
    .limit(1)
    .executeTakeFirst();
  return !any;
}

/** Registra na auditoria (padrão existente) que o número chegou ao limite ou que um contato foi recusado. */
export async function auditContactLimit(
  db: Db,
  o: {
    instanceId: number;
    usage: InstanceUsage;
    origin: 'manual' | 'campanha' | 'api';
    situation: 'atingido' | 'recusado';
    userId?: string | null;
    ip?: string | null;
    campaignId?: number | null;
  },
): Promise<void> {
  await audit(db, {
    userId: o.userId ?? null,
    action: 'limite_numero_atingido',
    entity: 'numero',
    entityId: o.instanceId,
    details: {
      dia: o.usage.date,
      situacao: o.situation,
      origem: o.origin,
      total: o.usage.total,
      limite: o.usage.limit,
      manual: o.usage.manual,
      automatico: o.usage.automatic,
      incerto: o.usage.uncertain,
      ...(o.campaignId ? { campanha: o.campaignId } : {}),
    },
    ip: o.ip ?? null,
  });
}

/** Avisa as telas abertas (tempo real) que o uso do dia do número mudou. Falha aqui nunca derruba um envio. */
export function notifyUsageChanged(instanceId: number): void {
  publishInstance(instanceId).catch(() => {});
}
