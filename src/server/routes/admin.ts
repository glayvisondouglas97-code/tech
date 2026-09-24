import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AuditItem, Page } from '../../shared/api';
import { requirePermission, requireUser } from '../http/auth-hooks';
import { parse } from '../http/validation';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/errors';
import { todayStampSP } from '../lib/time';
import {
  activityCsv,
  activityFeed,
  activitySummary,
  feedSchema,
  hideOwnerRows,
  periodSchema,
} from '../modules/activity/service';
import { blockPhone, listBlocked, parsePhoneOrThrow, unblockPhone } from '../modules/blocklist/service';
import { getDashboard } from '../modules/dashboard/service';
import { countForExport, csvStream, xlsxBuffer } from '../modules/export/service';
import { listFiltersSchema } from '../modules/leads/service';
import { deleteList, listLists, renameList, setArchived } from '../modules/lists/service';
import {
  anonymizeSubject,
  deleteSubject,
  exportSubjectData,
  searchByPhone,
} from '../modules/privacy/service';
import { getAppConfig, getSettings, listTemplates, toAdminSettings } from '../modules/settings/service';
import {
  createUser,
  listTeam,
  listUsers,
  passwordSetSchema,
  resetLink,
  setActive,
  setPassword,
  updateUser,
  userInputSchema,
  userUpdateSchema,
} from '../modules/users/service';

const uuid = z.string().uuid();

export async function adminRoutes(app: FastifyInstance) {
  const db = app.db;
  const idOf = (req: { params: unknown }) => {
    const r = uuid.safeParse((req.params as { id: string }).id);
    if (!r.success) throw notFound();
    return r.data;
  };

  // ---------- configuração geral (todos logados) ----------
  app.get('/app-config', async (req) => {
    requireUser(req);
    return { ...(await getAppConfig(db)), whatsapp: !!app.config.EVOLUTION_URL };
  });

  app.get('/branding', async () => {
    const s = await getSettings(db);
    return {
      companyName: s.company_name,
      logoUrl: s.logo ? `/api/branding/logo?v=${s.logo_updated_at?.getTime() ?? 0}` : null,
    };
  });

  app.get('/branding/logo', async (_req, reply) => {
    const s = await getSettings(db);
    if (!s.logo || !s.logo_mime) throw notFound();
    return reply.type(s.logo_mime).header('Cache-Control', 'public, max-age=86400').send(s.logo);
  });

  app.get('/health', async () => {
    await sql`SELECT 1`.execute(db);
    return { ok: true };
  });

  // ---------- painel ----------
  app.get('/dashboard', async (req) => getDashboard(db, requireUser(req)));

  app.get('/team', async (req) => {
    requirePermission(req, 'seeAllLeads');
    return listTeam(db);
  });

  // ---------- listas ----------
  app.get('/lists', async (req) => {
    requirePermission(req, 'seeAllLeads');
    const q = parse(z.object({ archived: z.enum(['0', '1']).default('0') }), req.query);
    return listLists(db, q.archived === '1');
  });

  app.post('/lists/:id/archive', async (req) => {
    const user = requirePermission(req, 'manageLists');
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    await setArchived(db, user, idOf(req), archived, req.ip);
    return { ok: true };
  });

  app.patch('/lists/:id', async (req) => {
    const user = requirePermission(req, 'manageLists');
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
    await renameList(db, user, idOf(req), name, req.ip);
    return { ok: true };
  });

  app.post('/lists/:id/delete', async (req) => {
    const user = requirePermission(req, 'deleteLists');
    const { confirm } = parse(z.object({ confirm: z.string().max(100) }), req.body);
    await deleteList(db, user, idOf(req), confirm, req.ip);
    return { ok: true };
  });

  // ---------- exportação ----------
  const exportFilters = listFiltersSchema.omit({ page: true, pageSize: true });

  app.get('/export/leads.csv', async (req, reply) => {
    const user = requirePermission(req, 'exportData');
    const f = { ...parse(exportFilters, req.query), page: 1, pageSize: 1 };
    const rows = await countForExport(db, user, f);
    await audit(db, {
      userId: user.id,
      action: 'exportou',
      details: { formato: 'csv', linhas: rows, filtros: auditFilters(f) },
      ip: req.ip,
    });
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="leads-${todayStampSP()}.csv"`)
      .header('Cache-Control', 'no-store')
      .send(await csvStream(db, user, f));
  });

  app.get('/export/leads.xlsx', async (req, reply) => {
    const user = requirePermission(req, 'exportData');
    const f = { ...parse(exportFilters, req.query), page: 1, pageSize: 1 };
    const buf = await xlsxBuffer(db, user, f);
    await audit(db, {
      userId: user.id,
      action: 'exportou',
      details: { formato: 'xlsx', filtros: auditFilters(f) },
      ip: req.ip,
    });
    return reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="leads-${todayStampSP()}.xlsx"`)
      .header('Cache-Control', 'no-store')
      .send(buf);
  });

  // ---------- usuários ----------
  app.get('/users', async (req) => {
    requirePermission(req, 'manageUsers');
    return listUsers(db);
  });

  app.post('/users', async (req) => {
    const admin = requirePermission(req, 'manageUsers');
    return createUser(db, admin, parse(userInputSchema, req.body), app.config.APP_URL, req.ip);
  });

  app.patch('/users/:id', async (req) => {
    const admin = requirePermission(req, 'manageUsers');
    await updateUser(db, admin, idOf(req), parse(userUpdateSchema, req.body), req.ip);
    return { ok: true };
  });

  app.post('/users/:id/active', async (req) => {
    const admin = requirePermission(req, 'manageUsers');
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    return setActive(db, admin, idOf(req), active, req.ip);
  });

  app.post('/users/:id/password', async (req) => {
    const admin = requirePermission(req, 'manageUsers');
    const { password } = parse(passwordSetSchema, req.body);
    await setPassword(db, admin, idOf(req), password, req.ip);
    return { ok: true };
  });

  app.post('/users/:id/password-link', async (req) => {
    const admin = requirePermission(req, 'manageUsers');
    return resetLink(db, admin, idOf(req), app.config.APP_URL, req.ip);
  });

  // ---------- configurações ----------
  app.get('/settings', async (req) => {
    requirePermission(req, 'manageSettings');
    return toAdminSettings(await getSettings(db));
  });

  app.put('/settings', async (req) => {
    const admin = requirePermission(req, 'manageSettings');
    const body = parse(
      z.object({
        companyName: z.string().trim().min(1).max(60),
        pullSize: z.number().int().min(1).max(1000),
        maxQueue: z.number().int().min(0).max(100_000),
        dailyPullLimit: z.number().int().min(0).max(100_000).default(0),
        expireHours: z.number().int().min(0).max(8760),
        hourlyContactWarning: z.number().int().min(0).max(10_000),
        defaultDdd: z
          .string()
          .nullable()
          .transform((v) => (v ? v.replace(/\D/g, '') : null))
          .refine((v) => !v || /^[1-9][0-9]$/.test(v), 'o DDD precisa ter 2 dígitos'),
      }),
      req.body,
    );
    await db
      .updateTable('settings')
      .set({
        company_name: body.companyName,
        pull_size: body.pullSize,
        max_queue: body.maxQueue,
        expire_hours: body.expireHours,
        hourly_contact_warning: body.hourlyContactWarning,
        daily_pull_limit: body.dailyPullLimit,
        default_ddd: body.defaultDdd || null,
        updated_at: sql`now()`,
        updated_by: admin.id,
      })
      .where('id', '=', 1)
      .execute();
    await audit(db, { userId: admin.id, action: 'alterou_configuracoes', details: body, ip: req.ip });
    return toAdminSettings(await getSettings(db));
  });

  app.put('/settings/logo', async (req) => {
    const admin = requirePermission(req, 'manageSettings');
    const file = await req.file();
    if (!file) throw badRequest('Nenhuma imagem recebida.');
    const data = await file.toBuffer();
    const mime = sniffImage(data);
    if (!mime) throw badRequest('Envie uma imagem PNG, JPG ou WebP.');
    if (data.length > 300 * 1024) throw badRequest('A imagem pode ter no máximo 300 KB.');
    await db
      .updateTable('settings')
      .set({ logo: data, logo_mime: mime, logo_updated_at: sql`now()`, updated_by: admin.id })
      .where('id', '=', 1)
      .execute();
    await audit(db, { userId: admin.id, action: 'alterou_logo', ip: req.ip });
    return { ok: true };
  });

  app.delete('/settings/logo', async (req) => {
    const admin = requirePermission(req, 'manageSettings');
    await db
      .updateTable('settings')
      .set({ logo: null, logo_mime: null, logo_updated_at: sql`now()` })
      .where('id', '=', 1)
      .execute();
    await audit(db, { userId: admin.id, action: 'removeu_logo', ip: req.ip });
    return { ok: true };
  });

  // ---------- mensagens prontas ----------
  const templateSchema = z.object({
    name: z.string().trim().min(1).max(60),
    body: z.string().trim().max(2000),
  });

  app.get('/templates', async (req) => {
    requireUser(req);
    return listTemplates(db);
  });

  app.post('/templates', async (req) => {
    const admin = requirePermission(req, 'manageSettings');
    const body = parse(templateSchema, req.body);
    const count = await db
      .selectFrom('message_templates')
      .select(sql<number>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    if (count.n >= 20) throw badRequest('Limite de 20 mensagens prontas.');
    const t = await db
      .insertInto('message_templates')
      .values({ name: body.name, body: body.body, is_default: count.n === 0, sort: count.n })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(db, {
      userId: admin.id,
      action: 'criou_mensagem',
      entity: 'mensagem',
      entityId: t.id,
      ip: req.ip,
    });
    return listTemplates(db);
  });

  app.put('/templates/:id', async (req) => {
    const admin = requirePermission(req, 'manageSettings');
    const id = idOf(req);
    const body = parse(templateSchema, req.body);
    const r = await db
      .updateTable('message_templates')
      .set({ name: body.name, body: body.body, updated_at: sql`now()` })
      .where('id', '=', id)
      .executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('Mensagem não encontrada.');
    await audit(db, {
      userId: admin.id,
      action: 'alterou_mensagem',
      entity: 'mensagem',
      entityId: id,
      ip: req.ip,
    });
    return listTemplates(db);
  });

  app.post('/templates/:id/default', async (req) => {
    const admin = requirePermission(req, 'manageSettings');
    const id = idOf(req);
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('message_templates')
        .set({ is_default: false })
        .where('is_default', '=', true)
        .execute();
      const r = await trx
        .updateTable('message_templates')
        .set({ is_default: true })
        .where('id', '=', id)
        .executeTakeFirst();
      if (!Number(r.numUpdatedRows)) throw notFound('Mensagem não encontrada.');
    });
    await audit(db, {
      userId: admin.id,
      action: 'mensagem_padrao',
      entity: 'mensagem',
      entityId: id,
      ip: req.ip,
    });
    return listTemplates(db);
  });

  app.delete('/templates/:id', async (req) => {
    const admin = requirePermission(req, 'manageSettings');
    const id = idOf(req);
    await db.transaction().execute(async (trx) => {
      const t = await trx
        .selectFrom('message_templates')
        .select('is_default')
        .where('id', '=', id)
        .executeTakeFirst();
      if (!t) throw notFound('Mensagem não encontrada.');
      await trx.deleteFrom('message_templates').where('id', '=', id).execute();
      if (t.is_default) {
        const next = await trx
          .selectFrom('message_templates')
          .select('id')
          .orderBy('sort')
          .executeTakeFirst();
        if (next)
          await trx
            .updateTable('message_templates')
            .set({ is_default: true })
            .where('id', '=', next.id)
            .execute();
      }
    });
    await audit(db, {
      userId: admin.id,
      action: 'excluiu_mensagem',
      entity: 'mensagem',
      entityId: id,
      ip: req.ip,
    });
    return listTemplates(db);
  });

  // ---------- não contatar ----------
  app.get('/blocklist', async (req) => {
    requirePermission(req, 'manageSettings');
    const q = parse(
      z.object({
        q: z.string().max(40).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    return listBlocked(db, q);
  });

  app.post('/blocklist', async (req) => {
    const admin = requirePermission(req, 'manageSettings');
    const body = parse(
      z.object({ phone: z.string().max(40), reason: z.string().trim().max(200).optional() }),
      req.body,
    );
    const settings = await getSettings(db);
    const phone = parsePhoneOrThrow(body.phone, settings.default_ddd);
    const leads = await db
      .transaction()
      .execute((trx) => blockPhone(trx, admin, phone, body.reason ?? null, req.ip));
    return { phone, leads };
  });

  app.post('/blocklist/remove', async (req) => {
    const admin = requirePermission(req, 'manageSettings');
    const { phone } = parse(z.object({ phone: z.string().regex(/^\d{8,15}$/) }), req.body);
    const leads = await db.transaction().execute((trx) => unblockPhone(trx, admin, phone, req.ip));
    return { leads };
  });

  // ---------- LGPD ----------
  const subjectSchema = z.object({ phone: z.string().max(40) });
  const subjectPhone = async (raw: string) => parsePhoneOrThrow(raw, (await getSettings(db)).default_ddd);

  app.post('/privacy/search', async (req) => {
    const admin = requirePermission(req, 'privacy');
    const { phone } = parse(subjectSchema, req.body);
    return searchByPhone(db, admin, await subjectPhone(phone), req.ip);
  });

  app.post('/privacy/export', async (req, reply) => {
    const admin = requirePermission(req, 'privacy');
    const { phone } = parse(subjectSchema, req.body);
    const data = await exportSubjectData(db, admin, await subjectPhone(phone), req.ip);
    return reply
      .type('application/json; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="dados-do-titular.json"')
      .header('Cache-Control', 'no-store')
      .send(JSON.stringify(data, null, 2));
  });

  const subjectActionSchema = subjectSchema.extend({
    block: z.boolean().default(true),
    confirm: z.literal(true),
  });

  app.post('/privacy/anonymize', async (req) => {
    const admin = requirePermission(req, 'privacy');
    const body = parse(subjectActionSchema, req.body);
    return anonymizeSubject(db, admin, await subjectPhone(body.phone), { block: body.block }, req.ip);
  });

  app.post('/privacy/delete', async (req) => {
    const admin = requirePermission(req, 'privacy');
    const body = parse(subjectActionSchema, req.body);
    return deleteSubject(db, admin, await subjectPhone(body.phone), { block: body.block }, req.ip);
  });

  // ---------- auditoria completa (resumo por pessoa, por dia e registro detalhado) ----------
  app.get('/activity/summary', async (req) => {
    const viewer = requirePermission(req, 'viewAudit');
    return activitySummary(db, viewer, parse(periodSchema, req.query));
  });

  app.get('/activity/feed', async (req) => {
    const viewer = requirePermission(req, 'viewAudit');
    return activityFeed(db, viewer, parse(feedSchema, req.query));
  });

  app.get('/activity/feed.csv', async (req, reply) => {
    const viewer = requirePermission(req, 'viewAudit');
    const f = parse(feedSchema, req.query);
    const { fileName, body } = await activityCsv(db, viewer, f);
    await audit(db, {
      userId: viewer.id,
      action: 'exportou_auditoria',
      details: { de: f.from ?? 'hoje', ate: f.to ?? f.from ?? 'hoje' },
      ip: req.ip,
    });
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .header('Cache-Control', 'no-store')
      .send(body);
  });

  // ---------- registro de ações (formato antigo) ----------
  app.get('/audit', async (req): Promise<Page<AuditItem>> => {
    const viewer = requirePermission(req, 'viewAudit');
    const q = parse(
      z.object({
        action: z.string().max(60).optional(),
        userId: uuid.optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    let base = db.selectFrom('audit_log as a');
    if (q.action) base = base.where('a.action', '=', q.action);
    if (q.userId) base = base.where('a.user_id', '=', q.userId);
    if (viewer.role !== 'dono') base = base.where(hideOwnerRows('a.user_id'));
    const [rows, count] = await Promise.all([
      base
        .leftJoin('users as u', 'u.id', 'a.user_id')
        .select([
          'a.id',
          'a.action',
          'a.entity',
          'a.entity_id',
          'a.details',
          'a.ip',
          'a.created_at',
          'a.user_id',
          'u.name as user_name',
        ])
        .orderBy('a.id', 'desc')
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize)
        .execute(),
      base.select(sql<number>`count(*)`.as('n')).executeTakeFirstOrThrow(),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        user: r.user_id ? { id: r.user_id, name: r.user_name ?? '' } : null,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        details: r.details ?? {},
        ip: r.ip,
        createdAt: r.created_at.toISOString(),
      })),
      total: count.n,
      page: q.page,
      pageSize: q.pageSize,
    };
  });
}

/** Filtros da exportação para o registro de auditoria, sem o texto da busca (pode ter nome de pessoa). */
function auditFilters(f: Record<string, unknown>) {
  const { q, page: _p, pageSize: _s, ...rest } = f;
  return q ? { ...rest, busca: true } : rest;
}

function sniffImage(b: Buffer): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
