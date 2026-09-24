import type { FastifyInstance } from 'fastify';
import { adminRoutes } from './admin';
import { authRoutes } from './auth';
import { importRoutes } from './imports';
import { leadRoutes } from './leads';
import { webhookRoutes } from './webhooks';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(authRoutes);
  await app.register(leadRoutes);
  await app.register(importRoutes);
  await app.register(adminRoutes);
  await app.register(webhookRoutes);
}
