import { type Kysely, type SelectQueryBuilder, sql } from 'kysely';
import { z } from 'zod';
import type {
  LeadDetail,
  LeadItem,
  Page,
  PullResult,
  QueueResponse,
  QueueStats,
  WhatsappOpenResult,
} from '../../../shared/api';
import { RESULT_IDS, type ResultId, resultLabel } from '../../../shared/results';
import { can } from '../../../shared/roles';
import { normalizeText } from '../../../shared/text';
import type { AuthUser } from '../../auth/sessions';
import type { Database, Lead } from '../../db/schema';
import { audit } from '../../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { addEvents, type NewEvent } from '../../lib/events';
import { spDateEnd, spDateStart, spDayStart } from '../../lib/time';
import { blockPhone } from '../blocklist/service';
import { getSettings } from '../settings/service';
import { canSee, selectLeads, toLeadItem, visibleTo } from './dto';

type Db = Kysely<Database>;

const NOT_FOUND = 'Lead não encontrado. Ele pode ter sido devolvido à fila ou passado para outra pessoa.';

const idSchema = z.coerce.number().int().positive();
export function parseLeadId(raw: unknown): number {
  const r = idSchema.safeParse(raw);
  if (!r.success) throw notFound(NOT_FOUND);
  return r.data;
}

async function lockLead(db: Db, id: number): Promise<Lead> {
  const lead = await db.selectFrom('leads').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!lead) throw notFound(NOT_FOUND);
  return lead;
}

async function loadItem(db: Db, id: number): Promise<LeadItem> {
  const row = await selectLeads(db).where('l.id', '=', id).executeTakeFirstOrThrow();
  return toLeadItem(row);
}

async function userName(db: Db, id: string | null): Promise<string | null> {
  if (!id) return null;
  const u = await db.selectFrom('users').select('name').where('id', '=', id).executeTakeFirst();
  return u?.name ?? null;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// biome-ignore lint/suspicious/noExplicitAny: filtro reaproveitado por consultas com seleções diferentes
function applySearch<QB extends SelectQueryBuilder<any, any, any>>(qb: QB, q: string | undefined): QB {
  const text = normalizeText(q ?? '');
  if (!text) return qb;
  const digits = (q ?? '').replace(/\D/g, '');
  const like = `%${escapeLike(text)}%`;
  return qb.where((eb) =>
    eb.or([
      eb('l.name_search', 'like', like),
      eb('l.company_search', 'like', like),
      eb(sql`lower(li.name)`, 'like', like),
      ...(digits.length >= 3 ? [eb('l.phone', 'like', `%${digits}%`)] : []),
    ]),
  ) as QB;
}

// ---------------------------------------------------------------- fila do atendente

export const dddSchema = z.string().regex(/^[1-9][0-9]$/, 'DDD precisa ter 2 dígitos');

export async function getQueue(
  db: Db,
  user: AuthUser,
  opts: { q?: string; limit: number; ddd?: string },
): Promise<QueueResponse> {
  let base = applySearch(
    selectLeads(db).where('l.status', '=', 'pendente').where('l.assigned_to', '=', user.id),
    opts.q,
  );
  if (opts.ddd) base = base.where('l.ddd', '=', opts.ddd);
  const [items, count, callbacks, ddds] = await Promise.all([
    base.orderBy('l.assigned_at').orderBy('l.id').limit(opts.limit).execute(),
    base.clearSelect().select(sql<number>`count(*)`.as('n')).executeTakeFirstOrThrow(),
    selectLeads(db)
      .where('l.called_by', '=', user.id)
      .where('l.status', '=', 'chamado')
      .where('l.callback_at', 'is not', null)
      .orderBy('l.callback_at')
      .limit(100)
      .execute(),
    db
      .selectFrom('leads as l')
      .select(['l.ddd', sql<number>`count(*)`.as('n')])
      .where('l.status', '=', 'pendente')
      .where('l.assigned_to', '=', user.id)
      .where('l.ddd', 'is not', null)
      .groupBy('l.ddd')
      .orderBy('l.ddd')
      .execute(),
  ]);
  return {
    items: items.map(toLeadItem),
    total: count.n,
    callbacks: callbacks.map(toLeadItem),
    ddds: ddds.map((d) => ({ ddd: d.ddd as string, count: d.n })),
  };
}

export async function countFree(db: Db): Promise<number> {
  const r = await db
    .selectFrom('leads as l')
    .innerJoin('lists as li', 'li.id', 'l.list_id')
    .select(sql<number>`count(*)`.as('n'))
    .where('l.status', '=', 'pendente')
    .where('l.assigned_to', 'is', null)
    .where('li.archived_at', 'is', null)
    .executeTakeFirstOrThrow();
  return r.n;
}

/** DDDs com leads na fila livre, para o atendente escolher de onde pegar. */
export async function freeDdds(db: Db): Promise<{ ddd: string; count: number }[]> {
  const rows = await db
    .selectFrom('leads as l')
    .innerJoin('lists as li', 'li.id', 'l.list_id')
    .select(['l.ddd', sql<number>`count(*)`.as('n')])
    .where('l.status', '=', 'pendente')
    .where('l.assigned_to', 'is', null)
    .where('li.archived_at', 'is', null)
    .where('l.ddd', 'is not', null)
    .groupBy('l.ddd')
    .orderBy('l.ddd')
    .execute();
  return rows.map((r) => ({ ddd: r.ddd as string, count: r.n }));
}

/** Limite diário do atendente: o dele, se tiver; senão o padrão da empresa. 0 = sem limite. */
async function dailyLimitFor(db: Db, userId: string, fallback: number): Promise<number> {
  const u = await db
    .selectFrom('users')
    .select('daily_pull_limit')
    .where('id', '=', userId)
    .executeTakeFirst();
  return u?.daily_pull_limit ?? fallback;
}

async function pulledToday(db: Db, userId: string): Promise<number> {
  const r = await db
    .selectFrom('lead_events')
    .select(sql<number>`count(*)`.as('n'))
    .where('user_id', '=', userId)
    .where('type', '=', 'pegou')
    .where('created_at', '>=', spDayStart(0))
    .executeTakeFirstOrThrow();
  return r.n;
}

export async function getQueueStats(db: Db, user: AuthUser): Promise<QueueStats> {
  const today = spDayStart(0);
  const tomorrow = spDayStart(-1);
  const [mine, done, free, callbacks, settings, pegouHoje] = await Promise.all([
    db
      .selectFrom('leads as l')
      .select(sql<number>`count(*)`.as('n'))
      .where('l.status', '=', 'pendente')
      .where('l.assigned_to', '=', user.id)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('leads as l')
      .select([
        sql<number>`count(*) FILTER (WHERE l.result <> 'sem_whatsapp')`.as('chamei'),
        sql<number>`count(*) FILTER (WHERE l.result = 'sem_whatsapp')`.as('sem'),
      ])
      .where('l.called_by', '=', user.id)
      .where('l.called_at', '>=', today)
      .executeTakeFirstOrThrow(),
    countFree(db),
    db
      .selectFrom('leads as l')
      .select(sql<number>`count(*)`.as('n'))
      .where('l.called_by', '=', user.id)
      .where('l.status', '=', 'chamado')
      .where('l.callback_at', '<', tomorrow)
      .executeTakeFirstOrThrow(),
    getSettings(db),
    pulledToday(db, user.id),
  ]);
  return {
    minhaFila: mine.n,
    chameiHoje: done.chamei,
    semWhatsappHoje: done.sem,
    livres: free,
    retornosHoje: callbacks.n,
    pullSize: settings.pull_size,
    maxQueue: settings.max_queue,
    pegouHoje,
    limiteDiario: await dailyLimitFor(db, user.id, settings.daily_pull_limit),
  };
}

export const pullSchema = z.object({
  quantity: z.number().int().min(1).max(1000).optional(),
  ddd: dddSchema.nullable().optional(),
});

/**
 * "Pegar leads": o atendente escolhe quantos (até o máximo por pedido) e, se quiser, o DDD.
 * Atômico: o SELECT ... FOR UPDATE SKIP LOCKED faz cada transação travar e levar linhas diferentes;
 * quem chega junto pula as travadas e pega as seguintes. Dois atendentes nunca recebem o mesmo lead.
 * Respeita o limite de fila e o limite diário do atendente. Cada pedido fica na auditoria.
 */
export async function pullLeads(
  db: Db,
  user: AuthUser,
  input: z.infer<typeof pullSchema> = {},
  ip: string | null = null,
): Promise<PullResult> {
  const settings = await getSettings(db);
  const requested = Math.min(input.quantity ?? settings.pull_size, settings.pull_size);
  const ddd = input.ddd ?? null;
  const dailyLimit = await dailyLimitFor(db, user.id, settings.daily_pull_limit);
  const ids = await db.transaction().execute(async (trx) => {
    // Clique duplo do mesmo atendente: uma requisição espera a outra terminar.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`pegar:${user.id}`}))`.execute(trx);
    let n = requested;
    if (dailyLimit > 0) {
      const today = await pulledToday(trx, user.id);
      const left = dailyLimit - today;
      if (left <= 0) {
        throw conflict(
          `Você já pegou ${today} leads hoje e seu limite diário é ${dailyLimit}. Amanhã você pode pegar mais.`,
        );
      }
      n = Math.min(n, left);
    }
    if (settings.max_queue > 0) {
      const mine = await trx
        .selectFrom('leads')
        .select(sql<number>`count(*)`.as('n'))
        .where('status', '=', 'pendente')
        .where('assigned_to', '=', user.id)
        .executeTakeFirstOrThrow();
      const room = settings.max_queue - mine.n;
      if (room <= 0) {
        throw conflict(
          `Você já tem ${mine.n} leads na fila (o limite é ${settings.max_queue}). Chame esses antes de pegar mais.`,
        );
      }
      n = Math.min(n, room);
    }
    const picked = await sql<{ id: number }>`
      WITH picked AS (
        SELECT l.id FROM leads l
        JOIN lists li ON li.id = l.list_id
        WHERE l.status = 'pendente' AND l.assigned_to IS NULL AND li.archived_at IS NULL
          ${ddd ? sql`AND l.ddd = ${ddd}` : sql``}
        ORDER BY l.id
        LIMIT ${n}
        FOR UPDATE OF l SKIP LOCKED
      )
      UPDATE leads SET assigned_to = ${user.id}, assigned_at = now(), assigned_via = 'pegou',
        whatsapp_opened_at = NULL, version = version + 1, updated_at = now()
      FROM picked
      WHERE leads.id = picked.id AND leads.status = 'pendente' AND leads.assigned_to IS NULL
      RETURNING leads.id`.execute(trx);
    const got = picked.rows.map((r) => r.id).sort((a, b) => a - b);
    await addEvents(
      trx,
      got.map((id) => ({ leadId: id, userId: user.id, type: 'pegou', data: ddd ? { ddd } : {} })),
    );
    await audit(trx, {
      userId: user.id,
      action: 'pediu_leads',
      details: { solicitados: input.quantity ?? requested, recebidos: got.length, ddd: ddd ?? 'todos' },
      ip,
    });
    return got;
  });
  const leads = ids.length ? await selectLeads(db).where('l.id', 'in', ids).orderBy('l.id').execute() : [];
  return { count: ids.length, leads: leads.map(toLeadItem) };
}

// ---------------------------------------------------------------- ações sobre um lead

const resultSchema = z.enum(RESULT_IDS);
const noteSchema = z
  .string()
  .max(1000, 'a observação pode ter no máximo 1.000 caracteres')
  .transform((s) => s.trim());
const callbackSchema = z.string().datetime({ offset: true, message: 'data de retorno inválida' }).nullable();

export const markSchema = z.object({
  result: resultSchema.default('enviado'),
  note: noteSchema.optional(),
  callbackAt: callbackSchema.optional(),
});

export async function markCalled(
  db: Db,
  user: AuthUser,
  id: number,
  input: z.infer<typeof markSchema>,
): Promise<LeadItem> {
  await db.transaction().execute(async (trx) => {
    const lead = await lockLead(trx, id);
    if (!canSee(user, lead)) throw notFound(NOT_FOUND);
    if (lead.status === 'chamado') {
      const who = await userName(trx, lead.called_by);
      throw conflict(`Este lead já foi marcado como chamado${who ? ` por ${who}` : ''}.`);
    }
    if (lead.status === 'bloqueado') throw conflict('Este número está na lista de não contatar.');
    if (lead.assigned_to !== user.id) {
      throw conflict('Este lead está na fila de outra pessoa. Atribua a você antes de marcar.');
    }
    const note = input.note === undefined ? lead.note : input.note || null;
    const callback = input.result === 'sem_whatsapp' ? null : (input.callbackAt ?? null);
    await trx
      .updateTable('leads')
      .set({
        status: 'chamado',
        called_by: user.id,
        called_at: sql`now()`,
        result: input.result,
        note,
        callback_at: callback,
        version: sql`version + 1`,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
    const events: NewEvent[] = [
      { leadId: id, userId: user.id, type: 'chamado', data: { resultado: input.result } },
    ];
    if (note !== lead.note && note)
      events.push({ leadId: id, userId: user.id, type: 'observacao', data: { texto: note } });
    if (callback)
      events.push({ leadId: id, userId: user.id, type: 'retorno_agendado', data: { para: callback } });
    await addEvents(trx, events);
  });
  return loadItem(db, id);
}

/** Desfaz a marcação: o lead volta para a fila de quem tinha marcado. O histórico guarda as duas ações. */
export async function undoCall(db: Db, user: AuthUser, id: number): Promise<LeadItem> {
  await db.transaction().execute(async (trx) => {
    const lead = await lockLead(trx, id);
    if (!canSee(user, lead)) throw notFound(NOT_FOUND);
    if (lead.status !== 'chamado' || !lead.called_by)
      throw conflict('Este lead não está marcado como chamado.');
    if (lead.called_by !== user.id && !can.manageLeads(user.role)) throw forbidden();
    await trx
      .updateTable('leads')
      .set({
        status: 'pendente',
        assigned_to: lead.called_by,
        assigned_at: lead.assigned_at ?? sql`now()`,
        assigned_via: lead.assigned_via ?? 'retorno',
        called_by: null,
        called_at: null,
        result: null,
        callback_at: null,
        version: sql`version + 1`,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
    await addEvents(trx, [
      {
        leadId: id,
        userId: user.id,
        type: 'desfeito',
        data: { resultado: lead.result, chamado_em: lead.called_at?.toISOString() ?? null },
      },
    ]);
  });
  return loadItem(db, id);
}

export const requeueSchema = z.object({
  to: z.union([z.literal('livre'), z.literal('minha'), z.string().uuid()]),
});

/** Devolve à fila livre, traz de volta para a própria fila (chamar de novo) ou passa para outra pessoa (gestor). */
export async function requeueLead(db: Db, user: AuthUser, id: number, to: string): Promise<LeadItem> {
  await db.transaction().execute(async (trx) => {
    const lead = await lockLead(trx, id);
    if (!canSee(user, lead)) throw notFound(NOT_FOUND);
    if (lead.status === 'bloqueado') throw conflict('Este número está na lista de não contatar.');
    if (lead.anonymized_at) throw conflict('Este lead foi anonimizado.');
    const manager = can.manageLeads(user.role);
    let target: { id: string; name: string } | null = null;
    if (to === 'minha') target = { id: user.id, name: user.name };
    else if (to !== 'livre') {
      if (!manager) throw forbidden('Só o gestor pode passar leads para outra pessoa.');
      const u = await trx
        .selectFrom('users')
        .select(['id', 'name'])
        .where('id', '=', to)
        .where('active', '=', true)
        .executeTakeFirst();
      if (!u) throw badRequest('Essa pessoa não está ativa na equipe.');
      target = u;
    }
    if (lead.status === 'pendente' && lead.assigned_to === (target?.id ?? null)) {
      throw conflict(
        target ? `Este lead já está na fila de ${target.name}.` : 'Este lead já está na fila livre.',
      );
    }
    const fromName = await userName(trx, lead.status === 'pendente' ? lead.assigned_to : lead.called_by);
    await trx
      .updateTable('leads')
      .set({
        status: 'pendente',
        assigned_to: target?.id ?? null,
        assigned_at: target ? sql`now()` : null,
        assigned_via: target ? (target.id === user.id ? 'retorno' : 'gestor') : null,
        called_by: null,
        called_at: null,
        result: null,
        callback_at: null,
        whatsapp_opened_at: null,
        version: sql`version + 1`,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
    await addEvents(trx, [
      target
        ? {
            leadId: id,
            userId: user.id,
            type: 'atribuido',
            data: {
              para: target.id,
              para_nome: target.name,
              de_nome: fromName,
              resultado_anterior: lead.result,
            },
          }
        : {
            leadId: id,
            userId: user.id,
            type: 'devolvido',
            data: { de_nome: fromName, resultado_anterior: lead.result },
          },
    ]);
  });
  return loadItem(db, id);
}

export const updateSchema = z.object({
  version: z.number().int().positive(),
  result: resultSchema.optional(),
  note: noteSchema.nullable().optional(),
  callbackAt: callbackSchema.optional(),
});

/** Edita resultado, observação e retorno. A versão evita que uma edição apague a de outra pessoa sem aviso. */
export async function updateLead(
  db: Db,
  user: AuthUser,
  id: number,
  input: z.infer<typeof updateSchema>,
): Promise<LeadItem> {
  await db.transaction().execute(async (trx) => {
    const lead = await lockLead(trx, id);
    if (!canSee(user, lead)) throw notFound(NOT_FOUND);
    if (lead.anonymized_at) throw conflict('Este lead foi anonimizado.');
    if (lead.version !== input.version) {
      throw conflict(
        'Este lead foi alterado por outra pessoa agora há pouco. Os dados foram atualizados; confira e tente de novo.',
        {
          lead: await loadItem(trx, id),
        },
      );
    }
    const manager = can.manageLeads(user.role);
    const mine = lead.called_at ? lead.called_by === user.id : lead.assigned_to === user.id;
    if (!manager && !mine) throw forbidden();

    const set: Record<string, unknown> = {};
    const events: NewEvent[] = [];
    if (input.result !== undefined && input.result !== lead.result) {
      if (!lead.called_at) throw conflict('Marque o lead como chamado antes de escolher o resultado.');
      set.result = input.result;
      events.push({
        leadId: id,
        userId: user.id,
        type: 'resultado',
        data: { de: lead.result, para: input.result },
      });
      if (input.result === 'sem_whatsapp' && lead.callback_at) set.callback_at = null;
    }
    if (input.note !== undefined) {
      const note = input.note || null;
      if (note !== lead.note) {
        set.note = note;
        events.push({ leadId: id, userId: user.id, type: 'observacao', data: { texto: note ?? '' } });
      }
    }
    if (input.callbackAt !== undefined) {
      const current = lead.callback_at?.toISOString() ?? null;
      const next = input.callbackAt ? new Date(input.callbackAt).toISOString() : null;
      if (next !== current) {
        if (next && lead.status !== 'chamado')
          throw conflict('Só dá para agendar retorno de lead já chamado.');
        set.callback_at = next;
        events.push(
          next
            ? { leadId: id, userId: user.id, type: 'retorno_agendado', data: { para: next } }
            : { leadId: id, userId: user.id, type: 'retorno_cancelado', data: { era: current } },
        );
      }
    }
    if (!events.length) return;
    await trx
      .updateTable('leads')
      .set({ ...set, version: sql`version + 1`, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
    await addEvents(trx, events);
  });
  return loadItem(db, id);
}

/** Registra que o atendente abriu o WhatsApp e avisa se ele está abrindo conversas rápido demais. */
export async function markWhatsappOpened(db: Db, user: AuthUser, id: number): Promise<WhatsappOpenResult> {
  const lead = await db
    .selectFrom('leads')
    .select(['id', 'status', 'assigned_to', 'called_by', 'anonymized_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!lead || !canSee(user, lead)) throw notFound(NOT_FOUND);
  if (lead.anonymized_at) throw conflict('Este lead foi anonimizado.');
  await db.updateTable('leads').set({ whatsapp_opened_at: sql`now()` }).where('id', '=', id).execute();
  await addEvents(db, [{ leadId: id, userId: user.id, type: 'abriu_whatsapp' }]);

  const settings = await getSettings(db);
  let warning: string | null = null;
  if (settings.hourly_contact_warning > 0) {
    const r = await db
      .selectFrom('lead_events')
      .select(sql<number>`count(*)`.as('n'))
      .where('user_id', '=', user.id)
      .where('type', '=', 'abriu_whatsapp')
      .where('created_at', '>', sql<Date>`now() - interval '1 hour'`)
      .executeTakeFirstOrThrow();
    if (r.n >= settings.hourly_contact_warning) {
      warning = `Você abriu ${r.n} conversas na última hora. Vá com calma: muitas mensagens seguidas podem bloquear o número no WhatsApp.`;
    }
  }
  return { ok: true, warning };
}

// ---------------------------------------------------------------- WhatsApp pelo sistema

/** Lead que o usuário pode chamar pelo WhatsApp do sistema (mesma regra de visibilidade das outras telas). */
export async function leadForChat(
  db: Db,
  user: AuthUser,
  id: number,
): Promise<{ id: number; phone: string }> {
  const lead = await db
    .selectFrom('leads')
    .select(['id', 'phone', 'status', 'assigned_to', 'called_by', 'anonymized_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!lead || !canSee(user, lead)) throw notFound(NOT_FOUND);
  if (lead.anonymized_at) throw conflict('Este lead foi anonimizado.');
  if (lead.status === 'bloqueado') throw conflict('Este número está na lista de não contatar.');
  return { id: lead.id, phone: lead.phone };
}

/**
 * Primeira mensagem enviada pelo sistema na conversa do lead: ele sai da fila de quem enviou e fica
 * "Chamado · Mensagem enviada". Só vale para o lead que está na fila de quem enviou.
 */
export async function markSentFromChat(
  db: Db,
  leadId: number,
  userId: string,
  numberLabel: string,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const lead = await trx
      .selectFrom('leads')
      .select(['status', 'assigned_to', 'anonymized_at'])
      .where('id', '=', leadId)
      .forUpdate()
      .executeTakeFirst();
    if (lead?.status !== 'pendente' || lead.assigned_to !== userId || lead.anonymized_at) {
      return false;
    }
    await trx
      .updateTable('leads')
      .set({
        status: 'chamado',
        called_by: userId,
        called_at: sql`now()`,
        result: 'enviado',
        callback_at: null,
        version: sql`version + 1`,
        updated_at: sql`now()`,
      })
      .where('id', '=', leadId)
      .execute();
    await addEvents(trx, [
      {
        leadId,
        userId,
        type: 'chamado',
        data: { resultado: 'enviado', automatico: true, numero: numberLabel },
      },
    ]);
    return true;
  });
}

/** Resultados que passam sozinhos para "Respondeu" quando o lead responde pelo WhatsApp. */
const WAITING_REPLY: ResultId[] = ['enviado', 'nao_respondeu'];

/** O lead respondeu na conversa ligada a ele: "Mensagem enviada" (ou "não respondeu") vira "Respondeu". */
export async function markRepliedFromChat(db: Db, leadId: number, text: string | null): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const lead = await trx
      .selectFrom('leads')
      .select(['status', 'result', 'anonymized_at'])
      .where('id', '=', leadId)
      .forUpdate()
      .executeTakeFirst();
    if (
      lead?.status !== 'chamado' ||
      !lead.result ||
      !WAITING_REPLY.includes(lead.result) ||
      lead.anonymized_at
    ) {
      return false;
    }
    await trx
      .updateTable('leads')
      .set({ result: 'respondeu', version: sql`version + 1`, updated_at: sql`now()` })
      .where('id', '=', leadId)
      .execute();
    await addEvents(trx, [
      { leadId, userId: null, type: 'whatsapp_resposta', data: { texto: text?.slice(0, 500) ?? null } },
      {
        leadId,
        userId: null,
        type: 'resultado',
        data: { de: lead.result, para: 'respondeu', automatico: true },
      },
    ]);
    return true;
  });
}

export const optOutSchema = z.object({ reason: z.string().trim().max(200).optional() });

/** "Não quero mais contato": bloqueia o número (LGPD) e tira da fila todos os leads com ele. */
export async function optOut(
  db: Db,
  user: AuthUser,
  id: number,
  reason: string | undefined,
  ip: string | null,
): Promise<LeadItem> {
  await db.transaction().execute(async (trx) => {
    const lead = await lockLead(trx, id);
    if (!canSee(user, lead)) throw notFound(NOT_FOUND);
    if (lead.anonymized_at) throw conflict('Este lead foi anonimizado.');
    await blockPhone(trx, user, lead.phone, reason || 'Pediu para não ser contatado', ip);
  });
  return loadItem(db, id);
}

export async function getLeadDetail(db: Db, user: AuthUser, id: number): Promise<LeadDetail> {
  const row = await selectLeads(db).where('l.id', '=', id).where(visibleTo(user)).executeTakeFirst();
  if (!row) throw notFound(NOT_FOUND);
  const events = await db
    .selectFrom('lead_events as e')
    .leftJoin('users as u', 'u.id', 'e.user_id')
    .select(['e.id', 'e.type', 'e.data', 'e.created_at', 'e.user_id', 'u.name as user_name'])
    .where('e.lead_id', '=', id)
    .orderBy('e.id', 'desc')
    .limit(500)
    .execute();
  return {
    lead: toLeadItem(row),
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      data: e.data ?? {},
      createdAt: e.created_at.toISOString(),
      user: e.user_id ? { id: e.user_id, name: e.user_name ?? 'Usuário removido' } : null,
    })),
  };
}

// ---------------------------------------------------------------- listagens com filtro (servidor)

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data inválida');

export const listFiltersSchema = z.object({
  view: z.enum(['chamados', 'todos']).default('chamados'),
  q: z.string().trim().max(100).optional(),
  attendant: z.union([z.literal('me'), z.literal('livre'), z.string().uuid()]).optional(),
  result: z.enum(RESULT_IDS).optional(),
  status: z.enum(['pendente', 'livre', 'com_atendente', 'chamado', 'bloqueado', 'retorno']).optional(),
  period: z.enum(['hoje', '7d', '30d', 'tudo', 'personalizado']).optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  list: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListFilters = z.infer<typeof listFiltersSchema>;

// biome-ignore lint/suspicious/noExplicitAny: filtro reaproveitado por listagem, contagem e exportação
export function applyFilters<QB extends SelectQueryBuilder<any, any, any>>(
  qb0: QB,
  user: AuthUser,
  f: ListFilters,
): QB {
  let qb = qb0.where(visibleTo(user)) as QB;
  const manager = can.seeAllLeads(user.role);
  if (f.view === 'todos' && !manager) throw forbidden();
  const dateCol = f.view === 'chamados' ? 'l.called_at' : 'l.created_at';
  if (f.view === 'chamados') qb = qb.where('l.called_at', 'is not', null) as QB;

  const period = f.period ?? (f.view === 'chamados' ? '7d' : 'tudo');
  if (period === 'hoje') qb = qb.where(dateCol, '>=', spDayStart(0)) as QB;
  else if (period === '7d') qb = qb.where(dateCol, '>=', spDayStart(6)) as QB;
  else if (period === '30d') qb = qb.where(dateCol, '>=', spDayStart(29)) as QB;
  else if (period === 'personalizado') {
    if (f.from) qb = qb.where(dateCol, '>=', spDateStart(f.from)) as QB;
    if (f.to) qb = qb.where(dateCol, '<', spDateEnd(f.to)) as QB;
  }

  if (f.attendant) {
    const who = f.attendant === 'me' ? user.id : f.attendant;
    if (f.attendant === 'livre') {
      qb = qb.where('l.status', '=', 'pendente').where('l.assigned_to', 'is', null) as QB;
    } else if (f.view === 'chamados') {
      qb = qb.where('l.called_by', '=', who) as QB;
    } else {
      qb = qb.where((eb) =>
        eb.or([
          eb.and([eb('l.status', '=', 'pendente'), eb('l.assigned_to', '=', who)]),
          eb('l.called_by', '=', who),
        ]),
      ) as QB;
    }
  }
  if (f.result) qb = qb.where('l.result', '=', f.result as ResultId) as QB;
  if (f.list) qb = qb.where('l.list_id', '=', f.list) as QB;
  switch (f.status) {
    case 'pendente':
      qb = qb.where('l.status', '=', 'pendente') as QB;
      break;
    case 'livre':
      qb = qb.where('l.status', '=', 'pendente').where('l.assigned_to', 'is', null) as QB;
      break;
    case 'com_atendente':
      qb = qb.where('l.status', '=', 'pendente').where('l.assigned_to', 'is not', null) as QB;
      break;
    case 'chamado':
      qb = qb.where('l.called_at', 'is not', null) as QB;
      break;
    case 'bloqueado':
      qb = qb.where('l.status', '=', 'bloqueado') as QB;
      break;
    case 'retorno':
      qb = qb.where('l.status', '=', 'chamado').where('l.callback_at', 'is not', null) as QB;
      break;
  }
  return applySearch(qb, f.q);
}

export async function listLeads(db: Db, user: AuthUser, f: ListFilters): Promise<Page<LeadItem>> {
  const base = applyFilters(selectLeads(db), user, f);
  const ordered =
    f.view === 'chamados'
      ? base.orderBy('l.called_at', 'desc').orderBy('l.id', 'desc')
      : f.status === 'retorno'
        ? base.orderBy('l.callback_at').orderBy('l.id')
        : base.orderBy('l.id');
  const [rows, count] = await Promise.all([
    ordered
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize)
      .execute(),
    base.clearSelect().select(sql<number>`count(*)`.as('n')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map(toLeadItem), total: count.n, page: f.page, pageSize: f.pageSize };
}

// ---------------------------------------------------------------- operações do gestor

export const bulkSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(1000),
  action: z.enum(['atribuir', 'devolver']),
  userId: z.string().uuid().optional(),
});

async function activeUser(db: Db, id: string) {
  const u = await db
    .selectFrom('users')
    .select(['id', 'name'])
    .where('id', '=', id)
    .where('active', '=', true)
    .executeTakeFirst();
  if (!u) throw badRequest('Essa pessoa não está ativa na equipe.');
  return u;
}

/**
 * Move leads pendentes (selecionados) para uma pessoa ou para a fila livre.
 * Leads já chamados são ignorados: para eles use "devolver" na linha, que limpa o resultado.
 */
export async function bulkMove(
  db: Db,
  user: AuthUser,
  input: z.infer<typeof bulkSchema>,
): Promise<{ moved: number; skipped: number }> {
  const target = input.action === 'atribuir' ? await activeUser(db, input.userId ?? '') : null;
  const moved = await db.transaction().execute(async (trx) => {
    const rows = await sql<{ id: number; old: string | null; old_name: string | null }>`
      UPDATE leads l SET assigned_to = ${target?.id ?? null}, assigned_at = ${target ? sql`now()` : null},
        assigned_via = ${target ? 'gestor' : null}, whatsapp_opened_at = NULL,
        version = l.version + 1, updated_at = now()
      FROM (
        SELECT x.id, x.assigned_to AS old FROM leads x
        WHERE x.id = ANY(${input.ids}::bigint[]) AND x.status = 'pendente'
          AND x.assigned_to IS DISTINCT FROM ${target?.id ?? null}::uuid
        FOR UPDATE
      ) o
      LEFT JOIN users u ON u.id = o.old
      WHERE l.id = o.id
      RETURNING l.id, o.old, u.name AS old_name`.execute(trx);
    await addEvents(
      trx,
      rows.rows.map((r) =>
        target
          ? {
              leadId: r.id,
              userId: user.id,
              type: 'atribuido',
              data: { para: target.id, para_nome: target.name, de_nome: r.old_name },
            }
          : { leadId: r.id, userId: user.id, type: 'devolvido', data: { de_nome: r.old_name } },
      ),
    );
    return rows.rows.length;
  });
  return { moved, skipped: input.ids.length - moved };
}

export const redistributeSchema = z.object({
  from: z.union([z.literal('livre'), z.string().uuid()]),
  to: z.array(z.string().uuid()).min(1).max(200),
  quantity: z.number().int().min(1).max(100_000).optional(),
  listId: z.string().uuid().optional(),
});

/** Reparte leads pendentes (da fila livre ou de uma pessoa) em partes iguais entre os escolhidos. */
export async function redistribute(
  db: Db,
  user: AuthUser,
  input: z.infer<typeof redistributeSchema>,
): Promise<{ moved: number; perUser: { id: string; name: string; count: number }[] }> {
  const targets: { id: string; name: string }[] = [];
  for (const id of [...new Set(input.to)]) targets.push(await activeUser(db, id));
  const fromName = input.from === 'livre' ? null : await userName(db, input.from);
  return db.transaction().execute(async (trx) => {
    let q = trx
      .selectFrom('leads as l')
      .innerJoin('lists as li', 'li.id', 'l.list_id')
      .select(['l.id', 'l.assigned_to'])
      .where('l.status', '=', 'pendente')
      .where('li.archived_at', 'is', null)
      .orderBy('l.id')
      .forUpdate('l')
      .skipLocked();
    q =
      input.from === 'livre'
        ? q.where('l.assigned_to', 'is', null)
        : q.where('l.assigned_to', '=', input.from);
    if (input.listId) q = q.where('l.list_id', '=', input.listId);
    if (input.quantity) q = q.limit(input.quantity);
    const rows = await q.execute();
    const buckets = new Map<string, number[]>(targets.map((t) => [t.id, []]));
    const movable = rows.filter((r) => !(targets.length === 1 && r.assigned_to === targets[0]?.id));
    for (const [i, r] of movable.entries()) {
      buckets.get((targets[i % targets.length] as { id: string }).id)?.push(r.id);
    }
    const perUser = [];
    for (const t of targets) {
      const ids = buckets.get(t.id) ?? [];
      perUser.push({ id: t.id, name: t.name, count: ids.length });
      if (!ids.length) continue;
      await trx
        .updateTable('leads')
        .set({
          assigned_to: t.id,
          assigned_at: sql`now()`,
          assigned_via: 'gestor',
          whatsapp_opened_at: null,
          version: sql`version + 1`,
          updated_at: sql`now()`,
        })
        .where('id', 'in', ids)
        .execute();
      await addEvents(
        trx,
        ids.map((id) => ({
          leadId: id,
          userId: user.id,
          type: 'atribuido',
          data: { para: t.id, para_nome: t.name, de_nome: fromName },
        })),
      );
    }
    return { moved: movable.length, perUser };
  });
}

export const releaseSchema = z.object({
  userId: z.string().uuid().optional(),
  olderThanHours: z.number().int().min(0).max(8760).optional(),
  onlyNotOpened: z.boolean().default(false),
});

/**
 * Devolve à fila livre leads pendentes que estão com atendentes.
 * Também usado pela expiração automática (sem usuário, só leads pegos e não abertos no WhatsApp).
 */
export async function releaseLeads(
  db: Db,
  user: AuthUser | null,
  input: {
    userId?: string;
    olderThanHours?: number;
    onlyNotOpened?: boolean;
    onlyPulled?: boolean;
    reason?: string;
  },
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const rows = await sql<{ id: number; old_name: string | null }>`
      UPDATE leads l SET assigned_to = NULL, assigned_at = NULL, assigned_via = NULL, whatsapp_opened_at = NULL,
        version = l.version + 1, updated_at = now()
      FROM (
        SELECT x.id, x.assigned_to AS old FROM leads x
        WHERE x.status = 'pendente' AND x.assigned_to IS NOT NULL
          ${input.userId ? sql`AND x.assigned_to = ${input.userId}::uuid` : sql``}
          ${input.olderThanHours ? sql`AND x.assigned_at < now() - make_interval(hours => ${input.olderThanHours}::int)` : sql``}
          ${input.onlyNotOpened ? sql`AND x.whatsapp_opened_at IS NULL` : sql``}
          ${input.onlyPulled ? sql`AND x.assigned_via = 'pegou'` : sql``}
        FOR UPDATE SKIP LOCKED
      ) o
      LEFT JOIN users u ON u.id = o.old
      WHERE l.id = o.id
      RETURNING l.id, u.name AS old_name`.execute(trx);
    await addEvents(
      trx,
      rows.rows.map((r) => ({
        leadId: r.id,
        userId: user?.id ?? null,
        type: user ? 'devolvido' : 'expirado',
        data: { de_nome: r.old_name, motivo: input.reason ?? null },
      })),
    );
    return rows.rows.length;
  });
}

export function describeResult(id: string | null): string {
  return id ? resultLabel(id) : '';
}
