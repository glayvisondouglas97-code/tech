import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../http/auth-hooks';
import { parse } from '../http/validation';
import {
  campaignCalendar,
  campaignStats,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  previewCampaign,
  resumeCampaign,
  startCampaign,
  stopCampaign,
  updateCampaign,
} from '../modules/automations/campaigns';
import { listRuns } from '../modules/automations/runs';
import {
  archiveAutomation,
  createAutomation,
  getAutomation,
  listAutomations,
  setAutomationStatus,
  updateAutomation,
} from '../modules/automations/service';
import { createStep, deleteStep, listSteps, reorderSteps, updateStep } from '../modules/automations/steps';
import { startManualRun } from '../modules/automations/triggers';
import {
  automationCreateSchema,
  automationListSchema,
  automationStatusSchema,
  automationUpdateSchema,
  calendarQuerySchema,
  campaignCreateSchema,
  campaignUpdateSchema,
  manualRunSchema,
  parseAutomationId,
  parseCampaignId,
  parseStepId,
  runsQuerySchema,
  stepCreateSchema,
  stepReorderSchema,
  stepUpdateSchema,
} from '../modules/automations/validation';

/**
 * Rotas de automações: a automação, as etapas dela, a execução manual e as campanhas. Todas exigem `manageAutomations`.
 * Quem executa as automações ativas é o job do scheduler (`modules/automations/executor.ts`).
 * Convenção: criar = POST (201), alterar = PATCH, excluir = DELETE, ações = POST (`/archive`, `/reorder`).
 * As rotas de etapas devolvem a lista completa das etapas, já na ordem nova.
 */
export async function automationsRoutes(app: FastifyInstance) {
  const db = app.db;
  const idOf = (req: { params: unknown }) => parseAutomationId((req.params as { id: string }).id);

  app.get('/automations', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    const { archived } = parse(automationListSchema, req.query);
    return listAutomations(db, user, archived === '1');
  });

  app.get('/automations/:id', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    return getAutomation(db, user, idOf(req));
  });

  app.post('/automations', async (req, reply) => {
    const user = requirePermission(req, 'manageAutomations');
    const input = parse(automationCreateSchema, req.body ?? {});
    return reply.status(201).send(await createAutomation(db, user, input, req.ip));
  });

  app.patch('/automations/:id', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    const id = idOf(req);
    return updateAutomation(db, user, id, parse(automationUpdateSchema, req.body ?? {}), req.ip);
  });

  app.patch('/automations/:id/status', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    const id = idOf(req);
    const { status } = parse(automationStatusSchema, req.body ?? {});
    return setAutomationStatus(db, user, id, status, req.ip);
  });

  app.post('/automations/:id/archive', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    return archiveAutomation(db, user, idOf(req), req.ip);
  });

  // ---------- etapas ----------
  const stepIdOf = (req: { params: unknown }) => parseStepId((req.params as { stepId: string }).stepId);

  app.get('/automations/:id/steps', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    return listSteps(db, user, idOf(req));
  });

  app.post('/automations/:id/steps', async (req, reply) => {
    const user = requirePermission(req, 'manageAutomations');
    const id = idOf(req);
    const input = parse(stepCreateSchema, req.body ?? {});
    return reply.status(201).send(await createStep(db, user, id, input, req.ip));
  });

  app.post('/automations/:id/steps/reorder', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    const id = idOf(req);
    const { stepIds } = parse(stepReorderSchema, req.body ?? {});
    return reorderSteps(db, user, id, stepIds, req.ip);
  });

  app.patch('/automations/:id/steps/:stepId', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    const id = idOf(req);
    const stepId = stepIdOf(req);
    return updateStep(db, user, id, stepId, parse(stepUpdateSchema, req.body ?? {}), req.ip);
  });

  app.delete('/automations/:id/steps/:stepId', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    const id = idOf(req);
    return deleteStep(db, user, id, stepIdOf(req), req.ip);
  });

  // ---------- execução ----------

  // Inicia a automação para UM lead, pelo número escolhido. Não existe versão "vários leads".
  app.post('/automations/:id/run', async (req, reply) => {
    const user = requirePermission(req, 'manageAutomations');
    const id = idOf(req);
    const input = parse(manualRunSchema, req.body ?? {});
    return reply.status(201).send(await startManualRun(db, user, id, input, req.ip));
  });

  // Participações mais recentes (diagnóstico: o que o executor está fazendo).
  app.get('/automations/:id/runs', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    const id = idOf(req);
    const { limit, campaignId } = parse(runsQuerySchema, req.query);
    await getAutomation(db, user, id); // 404 se a automação não existir
    return listRuns(db, id, limit, { campaignId });
  });

  // ---------- campanhas ----------
  // Iniciar uma automação para os leads de uma lista, pelos números escolhidos, dentro do horário de trabalho.
  // Quem seleciona os leads e envia é o job do scheduler; estas rotas só comandam a campanha e mostram o estado.
  const campaignIdOf = (req: { params: unknown }) =>
    parseCampaignId((req.params as { campaignId: string }).campaignId);

  app.get('/automations/:id/campaigns', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    const id = idOf(req);
    await getAutomation(db, user, id);
    return listCampaigns(db, id);
  });

  // Antes de iniciar ou agendar: o público (agregado), os números com a cota de hoje, a capacidade, a estimativa e o
  // calendário. POST porque o corpo leva os filtros; não grava nada.
  app.post('/automations/:id/campaigns/preview', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    const id = idOf(req);
    return previewCampaign(db, user, id, parse(campaignCreateSchema, req.body ?? {}));
  });

  app.post('/automations/:id/campaigns', async (req, reply) => {
    const user = requirePermission(req, 'manageAutomations');
    const id = idOf(req);
    const input = parse(campaignCreateSchema, req.body ?? {});
    return reply.status(201).send(await startCampaign(db, user, id, input, req.ip));
  });

  app.get('/automations/:id/campaigns/:campaignId', async (req) => {
    requirePermission(req, 'manageAutomations');
    return getCampaign(db, idOf(req), campaignIdOf(req));
  });

  // Contadores e explicações: por que a campanha pode estar parada.
  app.get('/automations/:id/campaigns/:campaignId/stats', async (req) => {
    requirePermission(req, 'manageAutomations');
    return campaignStats(db, idOf(req), campaignIdOf(req));
  });

  // Capacidade dos próximos dias e estimativa de duração.
  app.get('/automations/:id/campaigns/:campaignId/calendar', async (req) => {
    requirePermission(req, 'manageAutomations');
    const { days } = parse(calendarQuerySchema, req.query);
    return campaignCalendar(db, idOf(req), campaignIdOf(req), days);
  });

  // Alterar o que vale para os próximos leads (números, horário, dias, datas, cooldown, filtros, limite).
  app.patch('/automations/:id/campaigns/:campaignId', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    const input = parse(campaignUpdateSchema, req.body ?? {});
    return updateCampaign(db, user, idOf(req), campaignIdOf(req), input, req.ip);
  });

  app.post('/automations/:id/campaigns/:campaignId/pause', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    return pauseCampaign(db, user, idOf(req), campaignIdOf(req), req.ip);
  });

  app.post('/automations/:id/campaigns/:campaignId/resume', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    return resumeCampaign(db, user, idOf(req), campaignIdOf(req), req.ip);
  });

  app.post('/automations/:id/campaigns/:campaignId/stop', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    return stopCampaign(db, user, idOf(req), campaignIdOf(req), req.ip);
  });
}
