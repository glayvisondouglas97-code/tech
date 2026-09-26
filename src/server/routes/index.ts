import type { FastifyInstance } from 'fastify';
import { adminRoutes } from './admin';
import { authRoutes } from './auth';
import { automationsRoutes } from './automations';
import { importRoutes } from './imports';
import { leadRoutes } from './leads';
import { whatsappRoutes } from './whatsapp';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(authRoutes);
  await app.register(leadRoutes);
  await app.register(importRoutes);
  await app.register(adminRoutes);
  await app.register(whatsappRoutes);
  await app.register(automationsRoutes);
}
