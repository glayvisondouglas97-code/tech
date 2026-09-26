import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../http/auth-hooks';
import {
  activateAutoCampaign,
  autoCampaignState,
  pauseAutoCampaign,
} from '../modules/automations/auto-campaign';

/**
 * Campanha automática (aba Automações): ver a situação e as métricas, ativar e pausar. Nada é configurável: a regra
 * (dias úteis, 10:00 às 16:00, 20 contatos por número por dia, áudio e número sorteados) é do sistema.
 * Só dono e administrador (`manageAutomations`), como o resto das automações.
 */
export async function autoCampaignRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/auto-campaign', async (req) => {
    requirePermission(req, 'manageAutomations');
    return autoCampaignState(db);
  });

  app.post('/auto-campaign/activate', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    return activateAutoCampaign(db, user, req.ip);
  });

  app.post('/auto-campaign/pause', async (req) => {
    const user = requirePermission(req, 'manageAutomations');
    return pauseAutoCampaign(db, user, req.ip);
  });
}
