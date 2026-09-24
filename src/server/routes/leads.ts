import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission, requireUser } from '../http/auth-hooks';
import { parse } from '../http/validation';
import {
  bulkMove,
  bulkSchema,
  dddSchema,
  freeDdds,
  getLeadDetail,
  getQueue,
  getQueueStats,
  listFiltersSchema,
  listLeads,
  markCalled,
  markSchema,
  optOut,
  optOutSchema,
  parseLeadId,
  pullLeads,
  pullSchema,
  redistribute,
  redistributeSchema,
  releaseLeads,
  releaseSchema,
  requeueLead,
  requeueSchema,
  undoCall,
  updateLead,
  updateSchema,
} from '../modules/leads/service';

export async function leadRoutes(app: FastifyInstance) {
  const db = app.db;

  // ---------- fila do atendente ----------
  app.get('/queue', async (req) => {
    const user = requireUser(req);
    const q = parse(
      z.object({
        q: z.string().trim().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(50),
        ddd: dddSchema.optional(),
      }),
      req.query,
    );
    return getQueue(db, user, q);
  });

  app.get('/queue/stats', async (req) => getQueueStats(db, requireUser(req)));

  app.get('/queue/ddds', async (req) => {
    requireUser(req);
    return freeDdds(db);
  });

  app.post('/queue/pull', async (req) =>
    pullLeads(db, requireUser(req), parse(pullSchema, req.body ?? {}), req.ip),
  );

  // ---------- um lead ----------
  app.get('/leads/:id', async (req) => {
    const user = requireUser(req);
    return getLeadDetail(db, user, parseLeadId((req.params as { id: string }).id));
  });

  app.post('/leads/:id/call', async (req) => {
    const user = requireUser(req);
    return markCalled(
      db,
      user,
      parseLeadId((req.params as { id: string }).id),
      parse(markSchema, req.body ?? {}),
    );
  });

  app.post('/leads/:id/undo', async (req) => {
    const user = requireUser(req);
    return undoCall(db, user, parseLeadId((req.params as { id: string }).id));
  });

  app.post('/leads/:id/requeue', async (req) => {
    const user = requireUser(req);
    const { to } = parse(requeueSchema, req.body);
    return requeueLead(db, user, parseLeadId((req.params as { id: string }).id), to);
  });

  app.patch('/leads/:id', async (req) => {
    const user = requireUser(req);
    return updateLead(
      db,
      user,
      parseLeadId((req.params as { id: string }).id),
      parse(updateSchema, req.body),
    );
  });

  app.post('/leads/:id/optout', async (req) => {
    const user = requireUser(req);
    const { reason } = parse(optOutSchema, req.body ?? {});
    return optOut(db, user, parseLeadId((req.params as { id: string }).id), reason, req.ip);
  });

  // ---------- listagens ----------
  app.get('/leads', async (req) => {
    const user = requireUser(req);
    return listLeads(db, user, parse(listFiltersSchema, req.query));
  });

  // ---------- operações do gestor ----------
  app.post('/leads/bulk', async (req) => {
    const user = requirePermission(req, 'manageLeads');
    return bulkMove(db, user, parse(bulkSchema, req.body));
  });

  app.post('/leads/redistribute', async (req) => {
    const user = requirePermission(req, 'manageLeads');
    return redistribute(db, user, parse(redistributeSchema, req.body));
  });

  app.post('/leads/release', async (req) => {
    const user = requirePermission(req, 'manageLeads');
    const body = parse(releaseSchema, req.body);
    const released = await releaseLeads(db, user, {
      ...body,
      reason: body.olderThanHours
        ? `parado há mais de ${body.olderThanHours} horas`
        : 'devolvido pelo gestor',
    });
    return { released };
  });
}
