import { createHmac } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Dashboard } from '../../src/shared/api';
import {
  type Client,
  createTestApp,
  createUser,
  loginAs,
  seedList,
  type TestApp,
  testPhone,
} from '../helpers';

let t: TestApp;
let admin: Client;
let ana: Client;
let leadIds: number[];

beforeAll(async () => {
  t = await createTestApp({
    env: {
      WHATSAPP_CLOUD_ENABLED: 'true',
      WHATSAPP_VERIFY_TOKEN: 'verifica',
      WHATSAPP_APP_SECRET: 'segredo-meta',
    },
  });
  const g = await createUser(t.db, { name: 'Gestora', role: 'dono' });
  const a = await createUser(t.db, { name: 'Ana', role: 'atendente' });
  const b = await createUser(t.db, { name: 'Bruno', role: 'atendente' });
  admin = await loginAs(t.app, g);
  ana = await loginAs(t.app, a);
  leadIds = (await seedList(t.db, { name: 'Base', count: 20, phoneStart: 0 })).leadIds;
  // Ana: 3 chamados hoje (1 interessado, 1 fechou, 1 sem whatsapp), 1 ontem às 23h (horário de SP)
  const set = async (id: number, who: string, result: string, when: ReturnType<typeof sql>) =>
    sql`UPDATE leads SET status = 'chamado', called_by = ${who}::uuid, assigned_to = ${who}::uuid,
      called_at = ${when}, result = ${result} WHERE id = ${id}`.execute(t.db);
  const todaySP = sql`(date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`;
  await set(leadIds[0] as number, a.id, 'interessado', sql`${todaySP} + interval '1 minute'`);
  await set(leadIds[1] as number, a.id, 'fechou', sql`${todaySP} + interval '2 minutes'`);
  await set(leadIds[2] as number, a.id, 'sem_whatsapp', sql`${todaySP} + interval '3 minutes'`);
  await set(leadIds[3] as number, a.id, 'enviado', sql`${todaySP} - interval '1 hour'`);
  // Bruno: 1 chamado há 10 dias e 2 na fila
  await set(leadIds[4] as number, b.id, 'enviado', sql`${todaySP} - interval '10 days'`);
  await sql`UPDATE leads SET assigned_to = ${b.id}::uuid, assigned_at = now() WHERE id IN (${leadIds[5]}, ${leadIds[6]})`.execute(
    t.db,
  );
});
afterAll(async () => t.close());

describe('painel do gestor', () => {
  it('conta por atendente com o "hoje" de São Paulo e sem contar "Sem WhatsApp"', async () => {
    const d: Dashboard = (await admin.get('/api/dashboard')).json();
    const byName = Object.fromEntries(d.perAttendant.map((p) => [p.user.name, p]));
    expect(byName.Ana).toMatchObject({
      hoje: 2,
      d7: 3,
      d30: 3,
      total: 3,
      interessados: 1,
      fechados: 1,
      semWhatsapp: 1,
      fila: 0,
    });
    expect(byName.Ana?.conversao).toBeCloseTo(33.3, 1);
    expect(byName.Bruno).toMatchObject({ hoje: 0, d7: 0, d30: 1, total: 1, fila: 2, conversao: 0 });
    expect(d.totals).toMatchObject({
      leads: 20,
      chamados: 4,
      semWhatsapp: 1,
      comAtendentes: 2,
      livres: 13,
      hoje: 2,
      listas: 1,
    });
    expect(d.lists[0]).toMatchObject({ name: 'Base', total: 20, chamados: 4, semWhatsapp: 1, livres: 13 });
    expect(d.results.find((r) => r.result === 'fechou')?.count).toBe(1);
    expect(d.daily).toHaveLength(14);
    expect(d.daily.at(-1)?.count).toBe(2);
    expect(d.daily.at(-2)?.count).toBe(1);
  });
});

describe('exportação', () => {
  it('CSV com ; e BOM, abre no Excel em português', async () => {
    const r = await admin.get('/api/export/leads.csv?view=todos');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = r.body.split('\r\n').filter(Boolean);
    expect(
      lines[0]?.startsWith('﻿Empresa;Sócio / proprietário;Telefone;Outros telefones;Tipo;Lista;Situação;'),
    ).toBe(true);
    expect(lines[0]).toContain(';Cidade');
    expect(lines).toHaveLength(21);
    expect(r.body).toContain(';Chamado;');
    expect(r.body).toContain(';Fechou negócio;');
    expect(r.body).toContain('(41) 98000-0000');
  });

  it('CSV filtrado só com os chamados de hoje', async () => {
    const r = await admin.get('/api/export/leads.csv?view=chamados&period=hoje');
    expect(r.body.split('\r\n').filter(Boolean)).toHaveLength(4);
  });

  it('XLSX legível', async () => {
    const r = await admin.get('/api/export/leads.xlsx?view=todos');
    expect(r.statusCode).toBe(200);
    const wb = XLSX.read(r.rawPayload, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Leads as XLSX.WorkSheet, { header: 1 });
    expect(rows).toHaveLength(21);
    expect(rows[0]?.[0]).toBe('Empresa');
  });

  it('exportação fica registrada na auditoria', async () => {
    const audit = (await admin.get('/api/audit?action=exportou')).json();
    expect(audit.total).toBeGreaterThanOrEqual(3);
  });
});

describe('LGPD', () => {
  it('busca, exporta e anonimiza os dados de uma pessoa', async () => {
    const phone = testPhone(0);
    await ana.patch(`/api/leads/${leadIds[0]}`, {
      version: (await ana.get(`/api/leads/${leadIds[0]}`)).json().lead.version,
      note: 'Mora na rua X',
    });
    const s = (await admin.post('/api/privacy/search', { phone: '(41) 98000-0000' })).json();
    expect(s.phone).toBe(phone);
    expect(s.leads).toHaveLength(1);
    const exp = await admin.post('/api/privacy/export', { phone: '41980000000' });
    expect(exp.headers['content-disposition']).toMatch(/dados-do-titular\.json/);
    expect(exp.json().registros[0].historico.length).toBeGreaterThan(0);

    expect(
      (await admin.post('/api/privacy/anonymize', { phone: '41980000000', block: true })).statusCode,
    ).toBe(400);
    const r = await admin.post('/api/privacy/anonymize', {
      phone: '41980000000',
      block: true,
      confirm: true,
    });
    expect(r.json()).toEqual({ leads: 1 });
    const lead = await t.db
      .selectFrom('leads')
      .selectAll()
      .where('id', '=', leadIds[0] as number)
      .executeTakeFirstOrThrow();
    expect(lead).toMatchObject({ name: 'Titular anonimizado', phone: '', note: null, extra: {} });
    expect(lead.called_at).not.toBeNull();
    const notes = await t.db
      .selectFrom('lead_events')
      .select('data')
      .where('lead_id', '=', lead.id)
      .where('type', '=', 'observacao')
      .execute();
    expect(notes.every((n) => JSON.stringify(n.data) === '{}')).toBe(true);
    expect(
      await t.db.selectFrom('blocked_phones').select('phone').where('phone', '=', phone).executeTakeFirst(),
    ).toBeTruthy();
    // métricas continuam contando o contato
    const d: Dashboard = (await admin.get('/api/dashboard')).json();
    expect(d.perAttendant.find((p) => p.user.name === 'Ana')?.interessados).toBe(1);
  });

  it('exclui de vez', async () => {
    const r = await admin.post('/api/privacy/delete', { phone: testPhone(19), block: false, confirm: true });
    expect(r.json()).toEqual({ leads: 1 });
    expect(
      await t.db
        .selectFrom('leads')
        .select('id')
        .where('id', '=', leadIds[19] as number)
        .executeTakeFirst(),
    ).toBeUndefined();
    const actions = (await admin.get('/api/audit')).json().items.map((i: { action: string }) => i.action);
    expect(actions).toContain('excluiu_titular');
    expect(actions).toContain('anonimizou_titular');
  });
});

describe('webhook da WhatsApp Cloud API (atrás de flag)', () => {
  const sign = (body: string) => `sha256=${createHmac('sha256', 'segredo-meta').update(body).digest('hex')}`;

  it('verificação do webhook', async () => {
    const ok = await t.app.inject({
      method: 'GET',
      url: '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verifica&hub.challenge=123',
    });
    expect(ok.body).toBe('123');
    const bad = await t.app.inject({
      method: 'GET',
      url: '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1',
    });
    expect(bad.statusCode).toBe(403);
  });

  it('resposta do cliente vira evento e muda "Mensagem enviada" para "Respondeu"', async () => {
    const phone = testPhone(3);
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            { value: { messages: [{ from: phone, type: 'text', text: { body: 'Oi! Tenho interesse' } }] } },
          ],
        },
      ],
    });
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/webhooks/whatsapp',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' },
    });
    expect(bad.statusCode).toBe(403);
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/webhooks/whatsapp',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ messages: 1, statuses: 0 });
    const lead = await t.db
      .selectFrom('leads')
      .select('result')
      .where('id', '=', leadIds[3] as number)
      .executeTakeFirstOrThrow();
    expect(lead.result).toBe('respondeu');
  });

  it('desligado por padrão', async () => {
    const off = await createTestApp();
    try {
      const r = await off.app.inject({ method: 'GET', url: '/api/webhooks/whatsapp?hub.mode=subscribe' });
      expect(r.statusCode).toBe(404);
    } finally {
      await off.close();
    }
  });
});
