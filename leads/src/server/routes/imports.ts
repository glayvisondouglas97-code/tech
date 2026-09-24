import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../http/auth-hooks';
import { parse } from '../http/validation';
import { badRequest } from '../lib/errors';
import {
  commitImport,
  createDraft,
  discardImport,
  getImportState,
  importOptionsSchema,
  listImports,
  previewImport,
  redetect,
  rejectedCsv,
} from '../modules/imports/service';

export async function importRoutes(app: FastifyInstance) {
  const db = app.db;
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.post('/imports/upload', async (req) => {
    const user = requirePermission(req, 'importLists');
    if (!req.isMultipart()) throw badRequest('Envie o arquivo pelo formulário.');
    const file = await req.file();
    if (!file) throw badRequest('Nenhum arquivo recebido.');
    const data = await file.toBuffer();
    return createDraft(db, user, { fileName: file.filename || 'arquivo', data, source: 'arquivo' });
  });

  app.post('/imports/paste', async (req) => {
    const user = requirePermission(req, 'importLists');
    const { text } = parse(z.object({ text: z.string().min(1).max(5_000_000) }), req.body);
    return createDraft(db, user, {
      fileName: 'Linhas coladas',
      data: Buffer.from(text, 'utf8'),
      source: 'colado',
    });
  });

  app.post('/imports/:id/detect', async (req) => {
    requirePermission(req, 'importLists');
    const body = parse(
      z.object({
        sheet: z.string().max(200).nullable().default(null),
        hasHeader: z.boolean().optional(),
        listName: z.string().max(80).optional(),
      }),
      req.body,
    );
    return redetect(db, idOf(req), body);
  });

  app.post('/imports/:id/preview', async (req) => {
    requirePermission(req, 'importLists');
    return previewImport(db, idOf(req), parse(importOptionsSchema, req.body));
  });

  app.post('/imports/:id/commit', async (req) => {
    const user = requirePermission(req, 'importLists');
    return commitImport(db, user, idOf(req), parse(importOptionsSchema, req.body), req.log);
  });

  app.get('/imports/:id', async (req) => {
    requirePermission(req, 'importLists');
    return getImportState(db, idOf(req));
  });

  app.delete('/imports/:id', async (req) => {
    requirePermission(req, 'importLists');
    await discardImport(db, idOf(req));
    return { ok: true };
  });

  app.get('/imports', async (req) => {
    requirePermission(req, 'importLists');
    return listImports(db);
  });

  app.get('/imports/:id/rejeitados.csv', async (req, reply) => {
    requirePermission(req, 'importLists');
    const { fileName, body } = await rejectedCsv(db, idOf(req));
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .header('Cache-Control', 'no-store')
      .send(body);
  });
}
