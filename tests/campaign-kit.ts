import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import type { Db } from '../src/server/db';
import { startCampaign } from '../src/server/modules/automations/campaigns';
import { runAutomationCycle } from '../src/server/modules/automations/executor';
import { advanceCampaigns } from '../src/server/modules/automations/queue';
import { addDays, spInstant } from '../src/server/modules/automations/window';
import type { AutomationItem, CampaignDetail, CampaignInput } from '../src/shared/api';
import { type FakeEvolution, startFakeEvolution } from './fake-evolution';
import {
  type Client,
  createTestApp,
  createUser,
  loginAs,
  seedList,
  type TestApp,
  testPhone,
} from './helpers';

/**
 * Ferramentas dos testes de campanha: banco de testes, Evolution de mentira, três números conectados, um gestor
 * e um atendente. O relógio é INJETADO: `tick(now)` roda um ciclo da fila e do executor "naquele instante", então
 * um dia inteiro de campanha (10:00 às 16:00) roda em poucos segundos, sem esperar de verdade.
 */

const TOKEN = 'token-do-webhook-de-teste';

/** Um dia de teste em São Paulo (terça-feira). */
export const DAY = '2026-03-10';
export const NEXT_DAY = addDays(DAY, 1);

/** Instante de São Paulo: hora, minuto e segundo do dia `day`. */
export const at = (hh: number, mm = 0, ss = 0, day = DAY) =>
  new Date(spInstant(day, hh * 60 + mm).getTime() + ss * 1000);

export interface StepSpec {
  text?: string;
  /** Id de um áudio da biblioteca (modo fixo) ou 'random' (sorteio entre os ativos). */
  audio?: number | 'random';
  delaySeconds?: number;
}

export interface Kit {
  t: TestApp;
  fake: FakeEvolution;
  admin: Client;
  ana: Client;
  adminUser: { id: string; name: string; email: string; role: 'admin' };
  anaId: string;
  /** Ids dos números whatsapp-01, 02 e 03 (todos conectados no começo de cada teste). */
  numbers: [number, number, number];
  names: [string, string, string];
  hook: (event: string, data: unknown, instance?: string) => Promise<LightMyRequestResponse>;
  makeAutomation: (steps: StepSpec[], opts?: { status?: 'active' | 'paused' | 'draft' }) => Promise<number>;
  uploadAudio: (label: string) => Promise<{ id: number; bytes: Buffer }>;
  newList: (
    count: number,
    opts?: { name?: string; assignTo?: string | null },
  ) => Promise<{ listId: string; leadIds: number[]; phones: string[] }>;
  startCampaign: (
    automationId: number,
    listId: string,
    instanceIds: number[],
    extra?: Record<string, unknown>,
  ) => Promise<{ statusCode: number; body: CampaignDetail & { message?: string } }>;
  /**
   * Inicia (ou agenda) uma campanha pelo serviço, com o relógio `now` injetado: é o jeito de testar datas, dias da semana e
   * "iniciar agora fora do horário" em qualquer dia do calendário. Os padrões dos testes: 10:00 às 16:00, limite 20, começa em
   * `DAY` e vale todos os dias (passe `daysOfWeek: undefined` para usar o padrão real, segunda a sexta).
   */
  startCampaignAt: (
    now: Date,
    automationId: number,
    listId: string,
    instanceIds: number[],
    extra?: Partial<CampaignInput>,
  ) => Promise<CampaignDetail>;
  /** Um ciclo da fila (reserva leads) e depois um do executor (envia o que venceu), no instante `now`. */
  tick: (now: Date, db?: Db) => Promise<{ reserved: number; sent: number }>;
  /** Roda `tick` de minuto em minuto, das `from` às `to` (horas decimais como minutos: 600 = 10:00) do dia `day`. */
  simulate: (o: { day?: string; from?: number; to?: number; step?: number; db?: Db }) => Promise<void>;
  sends: () => FakeEvolution['calls'];
  /** Envios por número (nome da instância na Evolution). */
  sendsByNumber: () => Record<string, number>;
  reply: (phone: string, instance: string) => Promise<LightMyRequestResponse>;
  /** Grava o uso do dia de um número (contatos manuais/automáticos/incertos), como se já tivessem acontecido. */
  seedUsage: (
    instanceId: number,
    date: string,
    counts: { manual?: number; automatic?: number; uncertain?: number },
  ) => Promise<void>;
  /** O uso do dia de um número, direto do banco. */
  usageRow: (
    instanceId: number,
    date: string,
  ) => Promise<{ manual: number; automatic: number; uncertain: number; total: number }>;
  /** Auditoria de limite de número (da campanha, ou do número quando `campaignId` não é informado). */
  numberLimitAudits: (filter?: {
    campaignId?: number;
    instanceId?: number;
  }) => Promise<{ details: Record<string, unknown> }[]>;
  auditActions: (automationId: number) => Promise<string[]>;
  campaignRuns: (campaignId: number) => Promise<
    {
      id: number;
      lead_id: number;
      instance_id: number | null;
      status: string;
      current_step: number;
      cancel_reason: string | null;
      next_run_at: Date | null;
    }[]
  >;
}

/**
 * Registra o antes e o depois de cada teste (banco, Evolution, números) e devolve as ferramentas. Use assim:
 * `const k = campaignKit();` no topo do arquivo, e `k.t`, `k.admin`... dentro dos testes.
 */
export function campaignKit(): Kit {
  const k = {} as Kit;
  let media = '';
  let seq = 0;
  let phoneSeq = 5000;

  k.hook = async (event, data, instance = 'whatsapp-01') =>
    await k.t.app.inject({
      method: 'POST',
      url: '/webhook/evolution',
      payload: { event, instance, data },
      headers: { 'x-webhook-token': TOKEN },
    });

  beforeAll(async () => {
    k.fake = await startFakeEvolution();
    media = mkdtempSync(join(tmpdir(), 'midias-campanha-'));
    k.t = await createTestApp({
      env: {
        EVOLUTION_URL: k.fake.url,
        EVOLUTION_API_KEY: 'chave-teste',
        WEBHOOK_TOKEN: TOKEN,
        MEDIA_DIR: media,
      },
    });
    const ana = await createUser(k.t.db, { name: 'Ana', role: 'atendente' });
    k.anaId = ana.id;
    k.ana = await loginAs(k.t.app, ana);
    const admin = await createUser(k.t.db, { name: 'Gestora', role: 'admin' });
    k.adminUser = admin as Kit['adminUser'];
    k.admin = await loginAs(k.t.app, admin);
    k.names = ['whatsapp-01', 'whatsapp-02', 'whatsapp-03'];
    for (const [i, name] of k.names.entries()) {
      await k.hook('connection.update', { state: 'open', wuid: `551190000000${i}@s.whatsapp.net` }, name);
    }
    const rows = await k.t.db.selectFrom('wa_instances').select(['id', 'name']).orderBy('name').execute();
    k.numbers = rows.map((r) => r.id) as Kit['numbers'];
    await k.t.db.updateTable('wa_instances').set({ owner_id: k.anaId }).execute();
  });

  afterAll(async () => {
    await k.t?.close();
    await k.fake?.close();
    rmSync(media, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Cada teste começa sem automações (levam junto etapas, participações, campanhas), sem áudios e sem sacos.
    await k.t.db.deleteFrom('automations').execute();
    await k.t.db.deleteFrom('wa_audios').execute();
    await k.t.db.deleteFrom('wa_audio_bags').execute();
    await k.t.db.deleteFrom('blocked_phones').execute();
    // A cota diária dos números (manual + automático) é do banco: cada teste começa com todos os números zerados.
    await k.t.db.deleteFrom('wa_instance_daily_usage').execute();
    // Listas de testes anteriores (e os leads delas) não podem aparecer em "Pegar leads" nem na contagem.
    await k.t.db.deleteFrom('lists').execute();
    await k.t.db.updateTable('wa_instances').set({ status: 'open' }).execute();
    k.fake.calls.length = 0;
    k.fake.failSends = null;
    k.fake.closed.clear();
  });

  k.uploadAudio = async (label) => {
    const bytes = Buffer.from(`conteudo-do-audio-${label}`);
    const r = await k.admin.request(
      'POST',
      `/api/audios?label=${encodeURIComponent(label)}&seconds=10`,
      bytes,
      { 'content-type': 'audio/ogg' },
    );
    expect(r.statusCode, r.body).toBe(201);
    return { id: r.json().id, bytes };
  };

  k.makeAutomation = async (steps, opts = {}) => {
    const created = await k.admin.post('/api/automations', { name: `Campanha ${++seq}`, trigger: 'manual' });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as AutomationItem).id;
    for (const spec of steps) {
      const isAudio = spec.audio !== undefined;
      const r = await k.admin.post(`/api/automations/${id}/steps`, {
        actionType: isAudio ? 'send_audio' : 'send_text',
        delaySeconds: spec.delaySeconds ?? 0,
        messageText: isAudio ? null : (spec.text ?? 'Olá!'),
        audioId: typeof spec.audio === 'number' ? spec.audio : null,
        audioMode: spec.audio === 'random' ? 'random' : 'fixed',
        conditions: [],
      });
      expect(r.statusCode, r.body).toBe(201);
    }
    const status = opts.status ?? 'active';
    if (status !== 'draft') {
      const r = await k.admin.patch(`/api/automations/${id}/status`, { status: 'active' });
      expect(r.statusCode, r.body).toBe(200);
      if (status === 'paused') await k.admin.patch(`/api/automations/${id}/status`, { status: 'paused' });
    }
    return id;
  };

  k.newList = async (count, opts = {}) => {
    const start = phoneSeq;
    phoneSeq += count + 5;
    // Leads livres: na fila, sem atendente (é quem a campanha atende).
    const seeded = await seedList(k.t.db, {
      name: opts.name,
      count,
      assignTo: opts.assignTo ?? null,
      phoneStart: start,
    });
    return {
      listId: seeded.listId,
      leadIds: seeded.leadIds,
      phones: seeded.leadIds.map((_, i) => testPhone(start + i)),
    };
  };

  k.startCampaign = async (automationId, listId, instanceIds, extra = {}) => {
    const r = await k.admin.post(`/api/automations/${automationId}/campaigns`, {
      listId,
      instanceIds,
      // Os testes andam pelo relógio injetado (DAY, uma terça-feira) e alguns usam o dia de hoje de verdade: começam em DAY
      // e valem todos os dias da semana (o padrão de segunda a sexta é testado nos testes de agenda).
      startDate: DAY,
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      ...extra,
    });
    return { statusCode: r.statusCode, body: r.json() };
  };

  k.startCampaignAt = (now, automationId, listId, instanceIds, extra = {}) =>
    startCampaign(
      k.t.db,
      k.adminUser,
      automationId,
      {
        listId,
        instanceIds,
        windowStart: '10:00',
        windowEnd: '16:00',
        dailyLimitPerNumber: 20,
        startDate: DAY,
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        ...extra,
      },
      null,
      now,
    );

  k.tick = async (now, db = k.t.db) => {
    const queue = await advanceCampaigns(db, { now });
    const cycle = await runAutomationCycle(db, { now, batchSize: 100 });
    return { reserved: queue.reserved, sent: cycle.sent };
  };

  k.simulate = async ({ day = DAY, from = 600, to = 965, step = 1, db = k.t.db }) => {
    for (let minute = from; minute <= to; minute += step) {
      await k.tick(spInstant(day, minute), db);
    }
  };

  k.sends = () => k.fake.calls.filter((c) => c.url.startsWith('/message/send'));
  k.sendsByNumber = () => {
    const count: Record<string, number> = {};
    for (const call of k.sends()) {
      const name = call.url.split('/').pop() ?? '';
      count[name] = (count[name] ?? 0) + 1;
    }
    return count;
  };

  k.reply = (phone, instance) =>
    k.hook(
      'messages.upsert',
      {
        key: { id: `IN-${++seq}`, remoteJid: `${phone}@s.whatsapp.net`, fromMe: false },
        pushName: 'Lead',
        status: 'DELIVERY_ACK',
        message: { conversation: 'Oi, pode falar!' },
        messageType: 'conversation',
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
      instance,
    );

  k.seedUsage = async (instanceId, date, counts) => {
    const manual = counts.manual ?? 0;
    const automatic = counts.automatic ?? 0;
    const uncertain = counts.uncertain ?? 0;
    await sql`
      INSERT INTO wa_instance_daily_usage (instance_id, usage_date, manual_contacts, automatic_contacts, uncertain_contacts, total_contacts)
      VALUES (${instanceId}, ${date}::date, ${manual}, ${automatic}, ${uncertain}, ${manual + automatic + uncertain})
      ON CONFLICT (instance_id, usage_date) DO UPDATE
        SET manual_contacts = EXCLUDED.manual_contacts, automatic_contacts = EXCLUDED.automatic_contacts,
            uncertain_contacts = EXCLUDED.uncertain_contacts, total_contacts = EXCLUDED.total_contacts`.execute(
      k.t.db,
    );
  };

  k.usageRow = async (instanceId, date) => {
    const r = await sql<{ manual: number; automatic: number; uncertain: number; total: number }>`
      SELECT manual_contacts AS manual, automatic_contacts AS automatic, uncertain_contacts AS uncertain, total_contacts AS total
      FROM wa_instance_daily_usage WHERE instance_id = ${instanceId} AND usage_date = ${date}::date`.execute(
      k.t.db,
    );
    return r.rows[0] ?? { manual: 0, automatic: 0, uncertain: 0, total: 0 };
  };

  k.numberLimitAudits = async (filter = {}) => {
    const rows = await k.t.db
      .selectFrom('audit_log')
      .select('details')
      .where('action', '=', 'limite_numero_atingido')
      .where('entity', '=', 'numero')
      .$if(filter.instanceId !== undefined, (qb) => qb.where('entity_id', '=', String(filter.instanceId)))
      .orderBy('id')
      .execute();
    return rows
      .map((r) => ({ details: r.details as Record<string, unknown> }))
      .filter((r) => filter.campaignId === undefined || r.details.campanha === filter.campaignId);
  };

  k.auditActions = async (automationId) =>
    (
      await k.t.db
        .selectFrom('audit_log')
        .select('action')
        .where('entity', '=', 'automacao')
        .where('entity_id', '=', String(automationId))
        .orderBy('id')
        .execute()
    ).map((row) => row.action);

  k.campaignRuns = (campaignId) =>
    k.t.db
      .selectFrom('automation_runs')
      .select(['id', 'lead_id', 'instance_id', 'status', 'current_step', 'cancel_reason', 'next_run_at'])
      .where('campaign_id', '=', campaignId)
      .orderBy('id')
      .execute();

  return k;
}
