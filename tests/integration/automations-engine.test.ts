import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '../../src/server/db';
import { startJobs } from '../../src/server/jobs/scheduler';
import { runAutomationCycle } from '../../src/server/modules/automations/executor';
import {
  BATCH_SIZE,
  CYCLE_SECONDS,
  MAX_ATTEMPTS,
  RETRY_SECONDS,
} from '../../src/server/modules/automations/schedule';
import { displayPhone } from '../../src/server/modules/imports/phone';
import type { AutomationItem, AutomationRunItem } from '../../src/shared/api';
import { type FakeEvolution, startFakeEvolution } from '../fake-evolution';
import {
  type Client,
  createTestApp,
  createUser,
  loginAs,
  seedList,
  type TestApp,
  testPhone,
} from '../helpers';

// O motor de execução das automações contra o PostgreSQL de testes e a Evolution de mentira.
// O tempo "passa" ajustando next_run_at no banco (nada de esperar de verdade).

const TOKEN = 'token-do-webhook-de-teste';
const WAIT = 50; // segundos de folga nas comparações de horário
let t: TestApp;
let fake: FakeEvolution;
let media: string;
let admin: Client;
let ana: Client;
let anaId: string;
let n1: number;
let n2: number;
let phoneSeq = 1000;
let msgSeq = 0;

function hook(event: string, data: unknown, instance = 'whatsapp-01') {
  return t.app.inject({
    method: 'POST',
    url: '/webhook/evolution',
    payload: { event, instance, data },
    headers: { 'x-webhook-token': TOKEN },
  });
}

beforeAll(async () => {
  fake = await startFakeEvolution();
  media = mkdtempSync(join(tmpdir(), 'midias-motor-'));
  t = await createTestApp({
    env: {
      EVOLUTION_URL: fake.url,
      EVOLUTION_API_KEY: 'chave-teste',
      WEBHOOK_TOKEN: TOKEN,
      MEDIA_DIR: media,
    },
  });
  const a = await createUser(t.db, { name: 'Ana', role: 'atendente' });
  anaId = a.id;
  ana = await loginAs(t.app, a);
  admin = await loginAs(t.app, await createUser(t.db, { name: 'Gestora', role: 'admin' }));
  await hook('connection.update', { state: 'open', wuid: '5511900000000@s.whatsapp.net' }, 'whatsapp-01');
  await hook('connection.update', { state: 'open', wuid: '5511911111111@s.whatsapp.net' }, 'whatsapp-02');
  const instances = await t.db.selectFrom('wa_instances').select(['id', 'name']).orderBy('name').execute();
  [n1, n2] = instances.map((i) => i.id) as [number, number];
  await t.db.updateTable('wa_instances').set({ owner_id: anaId }).execute();
});
afterAll(async () => {
  await t?.close();
  await fake?.close();
  rmSync(media, { recursive: true, force: true });
});

beforeEach(async () => {
  // Cada teste começa sem automações (leva junto etapas, participações e tentativas) e sem chamadas anotadas.
  await t.db.deleteFrom('automations').execute();
  await t.db.deleteFrom('wa_audios').execute();
  // A cota diária de contatos (20 por número, manual + automático) também vale para a execução manual: cada teste começa
  // com os números zerados, senão as centenas de envios deste arquivo esgotariam o dia.
  await t.db.deleteFrom('wa_instance_daily_usage').execute();
  await t.db.updateTable('wa_instances').set({ status: 'open' }).execute();
  fake.calls.length = 0;
  fake.failSends = null;
  fake.closed.clear();
});

// ---------- ajudantes ----------

interface StepSpec {
  text?: string;
  audioId?: number;
  delaySeconds?: number;
  conditions?: unknown[];
}

async function makeAutomation(
  steps: StepSpec[],
  opts: { trigger?: 'manual' | 'lead_called'; status?: 'active' | 'paused' | 'draft' } = {},
): Promise<{ id: number; stepIds: number[] }> {
  const created = await admin.post('/api/automations', {
    name: `Motor ${++msgSeq}`,
    trigger: opts.trigger ?? 'manual',
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = (created.json() as AutomationItem).id;
  for (const spec of steps) {
    const r = await admin.post(`/api/automations/${id}/steps`, {
      actionType: spec.audioId ? 'send_audio' : 'send_text',
      delaySeconds: spec.delaySeconds ?? 0,
      messageText: spec.audioId ? null : (spec.text ?? 'Olá!'),
      audioId: spec.audioId ?? null,
      conditions: spec.conditions ?? [],
    });
    expect(r.statusCode, r.body).toBe(201);
  }
  const status = opts.status ?? 'active';
  if (status !== 'draft') {
    const r = await admin.patch(`/api/automations/${id}/status`, { status: 'active' });
    expect(r.statusCode, r.body).toBe(200);
    if (status === 'paused') await admin.patch(`/api/automations/${id}/status`, { status: 'paused' });
  }
  const stepIds = (await admin.get(`/api/automations/${id}/steps`)).json().map((s: { id: number }) => s.id);
  return { id, stepIds };
}

interface NewLead {
  id: number;
  phone: string;
  name: string;
}

async function newLead(opts: { company?: string; assignTo?: string | null } = {}): Promise<NewLead> {
  const start = phoneSeq++;
  const seeded = await seedList(t.db, { count: 1, assignTo: opts.assignTo ?? anaId, phoneStart: start });
  const id = seeded.leadIds[0] as number;
  if (opts.company)
    await t.db.updateTable('leads').set({ company: opts.company }).where('id', '=', id).execute();
  return { id, phone: testPhone(start), name: `Cliente ${start + 1}` };
}

/** Conversa deste lead neste número (o "Chamar" cria uma; aqui criamos direto). */
async function linkConversation(lead: NewLead, instanceId: number): Promise<number> {
  // O contato é um só por telefone (vale para todos os números); a conversa é uma por número.
  const jid = `${lead.phone}@s.whatsapp.net`;
  const contact =
    (await t.db.selectFrom('wa_contacts').select('id').where('phone_jid', '=', jid).executeTakeFirst()) ??
    (await t.db
      .insertInto('wa_contacts')
      .values({ phone_jid: jid })
      .returning('id')
      .executeTakeFirstOrThrow());
  const conversation = await t.db
    .insertInto('wa_conversations')
    .values({ instance_id: instanceId, contact_id: contact.id, lead_id: lead.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  return conversation.id;
}

/** Participação já vencida (como se o tempo de espera tivesse passado). */
async function addRun(
  automationId: number,
  lead: NewLead,
  instanceId: number | null = n1,
  extra: Partial<{
    next_run_at: Date;
    started_by: string | null;
    started_at: Date;
    current_step: number;
  }> = {},
): Promise<number> {
  const row = await t.db
    .insertInto('automation_runs')
    .values({
      automation_id: automationId,
      lead_id: lead.id,
      instance_id: instanceId,
      started_by: anaId,
      status: 'pending',
      current_step: 1,
      started_at: new Date(Date.now() - 60_000),
      next_run_at: new Date(Date.now() - 1000),
      ...extra,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

const makeDue = (runId: number) =>
  t.db
    .updateTable('automation_runs')
    .set({ next_run_at: new Date(Date.now() - 1000) })
    .where('id', '=', runId)
    .where('status', '=', 'pending')
    .execute();

const runOf = (id: number) =>
  t.db.selectFrom('automation_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const stepRunsOf = (runId: number) =>
  t.db
    .selectFrom('automation_step_runs as sr')
    .leftJoin('automation_steps as s', 's.id', 'sr.step_id')
    .select(['sr.id', 'sr.status', 'sr.attempts', 'sr.error', 'sr.message_id', 's.position'])
    .where('sr.automation_run_id', '=', runId)
    .orderBy('sr.id')
    .execute();
const cycle = () => runAutomationCycle(t.db);
const sends = () => fake.calls.filter((c) => c.url.startsWith('/message/send'));
const textSends = () => fake.calls.filter((c) => c.url.startsWith('/message/sendText/'));
/** O texto enviado numa chamada de sendText da Evolution. */
const textOf = (call: { body: unknown } | undefined) => (call?.body as { text: string } | undefined)?.text;
const audioSends = () => fake.calls.filter((c) => c.url.startsWith('/message/sendWhatsAppAudio/'));
const near = (date: Date | null, expectedMs: number) =>
  expect(Math.abs((date?.getTime() ?? 0) - expectedMs)).toBeLessThan(WAIT * 1000);
const auditActions = async (automationId: number) =>
  (
    await t.db
      .selectFrom('audit_log')
      .select(['action', 'details'])
      .where('entity', '=', 'automacao')
      .where('entity_id', '=', String(automationId))
      .orderBy('id')
      .execute()
  ).map((row) => row.action);

async function uploadAudio(label: string): Promise<{ id: number; bytes: Buffer }> {
  const bytes = Buffer.from(`conteudo-do-audio-${label}`);
  const r = await admin.request('POST', `/api/audios?label=${encodeURIComponent(label)}&seconds=10`, bytes, {
    'content-type': 'audio/ogg',
  });
  expect(r.statusCode, r.body).toBe(201);
  return { id: r.json().id, bytes };
}

const reply = (lead: NewLead, instance = 'whatsapp-01') =>
  hook(
    'messages.upsert',
    {
      key: { id: `IN-${++msgSeq}`, remoteJid: `${lead.phone}@s.whatsapp.net`, fromMe: false },
      pushName: 'Lead',
      status: 'DELIVERY_ACK',
      message: { conversation: 'Oi, pode falar!' },
      messageType: 'conversation',
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
    instance,
  );

// ---------- 1. criar a participação: gatilho lead_called ----------

describe('gatilho lead_called (o botão "Chamar")', () => {
  const chamar = (lead: NewLead, instanceId: number, sendAudio = true) =>
    ana.post(`/api/leads/${lead.id}/conversation`, { instanceId, sendAudio });

  it('depois de um "Chamar" bem-sucedido cria a participação, ligada ao número que chamou', async () => {
    await uploadAudio('Apresentação');
    const automation = await makeAutomation([{ text: 'Primeiro' }, { text: 'Segundo', delaySeconds: 7200 }], {
      trigger: 'lead_called',
    });
    const lead = await newLead();

    const r = await chamar(lead, n2); // pelo número 2
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().audio.sent).toBe(true);

    const runs = await t.db
      .selectFrom('automation_runs')
      .selectAll()
      .where('lead_id', '=', lead.id)
      .execute();
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run).toMatchObject({
      automation_id: automation.id,
      instance_id: n2,
      started_by: anaId,
      status: 'pending',
      current_step: 1,
      cancel_reason: null,
    });
    expect(run?.started_at).toBeInstanceOf(Date);
    near(run?.next_run_at ?? null, Date.now()); // 1ª etapa imediata
    expect(await auditActions(automation.id)).toContain('criou_execucao_automacao');
    // O Chamar enviou só o áudio dele; a automação ainda não enviou nada.
    expect(textSends()).toHaveLength(0);
    expect(audioSends()).toHaveLength(1);
  });

  it('o momento da 1ª etapa respeita a espera dela', async () => {
    await uploadAudio('A');
    await makeAutomation([{ text: 'Depois de 2 horas', delaySeconds: 7200 }], { trigger: 'lead_called' });
    const lead = await newLead();
    expect((await chamar(lead, n1)).statusCode).toBe(200);
    const run = await t.db
      .selectFrom('automation_runs')
      .selectAll()
      .where('lead_id', '=', lead.id)
      .executeTakeFirstOrThrow();
    near(run.next_run_at, Date.now() + 7200_000);
  });

  it('chamar de novo não repete a sequência (em andamento, e nem depois de concluída)', async () => {
    await uploadAudio('A');
    await makeAutomation([{ text: 'Única' }], { trigger: 'lead_called' });
    const lead = await newLead();
    await chamar(lead, n1);
    await chamar(lead, n1);
    const count = async () =>
      (await t.db.selectFrom('automation_runs').select('id').where('lead_id', '=', lead.id).execute()).length;
    expect(await count()).toBe(1);
    await cycle(); // conclui a participação
    expect(
      (
        await t.db
          .selectFrom('automation_runs')
          .select('status')
          .where('lead_id', '=', lead.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('completed');
    await chamar(lead, n1);
    expect(await count()).toBe(1);
  });

  it('sem a mensagem inicial (biblioteca vazia ou sem áudio) não é uma chamada concluída: não cria nada', async () => {
    await makeAutomation([{ text: 'Não deve criar' }], { trigger: 'lead_called' });
    const lead = await newLead();
    const r = await chamar(lead, n1); // sem áudios salvos
    expect(r.statusCode).toBe(200);
    expect(r.json().audio.sent).toBe(false);
    const lead2 = await newLead();
    expect((await chamar(lead2, n1, false)).statusCode).toBe(200); // sem pedir áudio
    expect(await t.db.selectFrom('automation_runs').select('id').execute()).toEqual([]);
  });

  it('mensagem digitada à mão na conversa NÃO dispara a automação', async () => {
    await makeAutomation([{ text: 'Não deve criar' }], { trigger: 'lead_called' });
    const lead = await newLead();
    const opened = await chamar(lead, n1, false);
    const conversationId = opened.json().conversationId;
    const manual = await ana.post(`/api/conversations/${conversationId}/messages`, { text: 'Oi, tudo bem?' });
    expect(manual.statusCode, manual.body).toBe(201);
    expect(await t.db.selectFrom('automation_runs').select('id').execute()).toEqual([]);
  });

  it('só automações ATIVAS com gatilho lead_called entram (rascunho, pausada e manual, não)', async () => {
    await uploadAudio('A');
    await makeAutomation([{ text: 'a' }], { trigger: 'lead_called', status: 'draft' });
    await makeAutomation([{ text: 'b' }], { trigger: 'lead_called', status: 'paused' });
    await makeAutomation([{ text: 'c' }], { trigger: 'manual' });
    const lead = await newLead();
    expect((await chamar(lead, n1)).statusCode).toBe(200);
    expect(await t.db.selectFrom('automation_runs').select('id').execute()).toEqual([]);
  });

  it('vários leads chamados criam uma participação cada, sem se misturar', async () => {
    await uploadAudio('A');
    const automation = await makeAutomation([{ text: 'Oi' }], { trigger: 'lead_called' });
    const leads = [await newLead(), await newLead(), await newLead()];
    for (const lead of leads) await chamar(lead, n1);
    const runs = await t.db.selectFrom('automation_runs').select(['lead_id', 'automation_id']).execute();
    expect(runs.map((r) => r.lead_id).sort()).toEqual(leads.map((l) => l.id).sort());
    expect(new Set(runs.map((r) => r.automation_id))).toEqual(new Set([automation.id]));
  });
});

// ---------- 2. índice único e restrições ----------

describe('participação e tentativa: restrições do banco', () => {
  it('não existem duas participações em andamento do mesmo lead na mesma automação', async () => {
    const automation = await makeAutomation([{ text: 'Oi' }]);
    const lead = await newLead();
    await addRun(automation.id, lead);
    await expect(addRun(automation.id, lead)).rejects.toMatchObject({ code: '23505' });
    // Outro lead ou outra automação, pode.
    await expect(addRun(automation.id, await newLead())).resolves.toBeGreaterThan(0);
    const other = await makeAutomation([{ text: 'Oi' }]);
    await expect(addRun(other.id, lead)).resolves.toBeGreaterThan(0);
  });

  it('a mesma etapa não tem duas tentativas na mesma participação', async () => {
    const automation = await makeAutomation([{ text: 'Oi' }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);
    const values = {
      automation_run_id: runId,
      step_id: automation.stepIds[0] as number,
      scheduled_at: new Date(),
    };
    await t.db.insertInto('automation_step_runs').values(values).execute();
    await expect(t.db.insertInto('automation_step_runs').values(values).execute()).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('o número da participação fica guardado; se o número for excluído, fica vazio', async () => {
    const automation = await makeAutomation([{ text: 'Oi' }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead, n2);
    expect((await runOf(runId)).instance_id).toBe(n2);
    await t.db.updateTable('automation_runs').set({ instance_id: null }).where('id', '=', runId).execute();
    expect((await runOf(runId)).instance_id).toBeNull();
  });
});

// ---------- 3. execução de texto ----------

describe('execução: texto', () => {
  it('respeita a espera, envia UMA vez com as variáveis trocadas, grava a mensagem e avança', async () => {
    const automation = await makeAutomation([
      {
        text: 'Olá, {{nome}}! Aqui é {{atendente}} da equipe da {{empresa}}, pelo {{numero}} ({{telefone}}).',
      },
      { text: 'Conseguiu ver?', delaySeconds: 7200 },
    ]);
    const lead = await newLead({ company: 'Padaria Central' });
    const runId = await addRun(automation.id, lead, n1, { next_run_at: new Date(Date.now() + 3600_000) });

    // Ainda não venceu: nada acontece.
    expect(await cycle()).toMatchObject({ claimed: 0, sent: 0 });
    expect(sends()).toHaveLength(0);
    expect((await runOf(runId)).status).toBe('pending');

    // Venceu.
    await makeDue(runId);
    expect(await cycle()).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    expect(textSends()).toHaveLength(1);
    const call = textSends()[0];
    expect(call?.url).toBe('/message/sendText/whatsapp-01'); // o número da participação
    expect(textOf(call)).toBe(
      `Olá, ${lead.name}! Aqui é Ana da equipe da Padaria Central, pelo ${displayPhone('5511900000000')} (${displayPhone(lead.phone)}).`,
    );

    // Mensagem gravada na conversa do lead, sem ser "digitada" por ninguém.
    const message = await t.db
      .selectFrom('wa_messages as m')
      .innerJoin('wa_conversations as c', 'c.id', 'm.conversation_id')
      .select(['m.id', 'm.from_me', 'm.text', 'm.sent_by', 'c.lead_id', 'c.instance_id'])
      .where('c.lead_id', '=', lead.id)
      .executeTakeFirstOrThrow();
    expect(message).toMatchObject({ from_me: true, sent_by: null, lead_id: lead.id, instance_id: n1 });
    expect(message.text).toContain('Padaria Central');

    // Tentativa registrada e ligada à mensagem; a participação avançou para a etapa 2, 2 h depois.
    const [stepRun] = await stepRunsOf(runId);
    expect(stepRun).toMatchObject({ status: 'completed', attempts: 1, message_id: message.id, position: 1 });
    const run = await runOf(runId);
    expect(run).toMatchObject({ status: 'pending', current_step: 2 });
    near(run.next_run_at, Date.now() + 7200_000);
    expect(await auditActions(automation.id)).toContain('enviou_etapa_automacao');
  });

  it('a automação NÃO mexe no lead: não marca como chamado, não muda a fila nem o resultado', async () => {
    const automation = await makeAutomation([{ text: 'Oi' }]);
    const lead = await newLead();
    await addRun(automation.id, lead);
    const before = await t.db
      .selectFrom('leads')
      .selectAll()
      .where('id', '=', lead.id)
      .executeTakeFirstOrThrow();
    await cycle();
    expect(textSends()).toHaveLength(1);
    const after = await t.db
      .selectFrom('leads')
      .selectAll()
      .where('id', '=', lead.id)
      .executeTakeFirstOrThrow();
    expect(after).toMatchObject({
      status: 'pendente',
      called_by: null,
      called_at: null,
      result: null,
      assigned_to: before.assigned_to,
      version: before.version,
    });
    const events = await t.db
      .selectFrom('lead_events')
      .select('type')
      .where('lead_id', '=', lead.id)
      .execute();
    expect(events.map((e) => e.type)).not.toContain('chamado');
  });

  it('uma sequência completa de 3 etapas: cada uma no seu tempo, na ordem, e termina concluída', async () => {
    const automation = await makeAutomation([
      { text: 'Etapa um' },
      { text: 'Etapa dois', delaySeconds: 7200 },
      { text: 'Etapa três', delaySeconds: 86_400 },
    ]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);

    await cycle();
    expect(textSends().map((c) => (c.body as { text: string }).text)).toEqual(['Etapa um']);
    expect(await cycle()).toMatchObject({ claimed: 0 }); // a etapa 2 ainda não venceu
    await makeDue(runId);
    await cycle();
    await makeDue(runId);
    const last = await cycle();
    expect(last).toMatchObject({ sent: 1, completed: 1 });

    expect(textSends().map((c) => (c.body as { text: string }).text)).toEqual([
      'Etapa um',
      'Etapa dois',
      'Etapa três',
    ]);
    const run = await runOf(runId);
    expect(run.status).toBe('completed');
    expect(run.completed_at).toBeInstanceOf(Date);
    expect(run.next_run_at).toBeNull();
    const stepRuns = await stepRunsOf(runId);
    expect(stepRuns.map((s) => [s.position, s.status, s.attempts])).toEqual([
      [1, 'completed', 1],
      [2, 'completed', 1],
      [3, 'completed', 1],
    ]);
    expect(await auditActions(automation.id)).toContain('concluiu_execucao_automacao');
  });

  it('vários leads na mesma automação: cada um recebe a sua mensagem, com os seus dados', async () => {
    const automation = await makeAutomation([{ text: 'Oi, {{nome}} ({{empresa}})' }]);
    const leads = [
      await newLead({ company: 'Alfa' }),
      await newLead({ company: 'Beta' }),
      await newLead({ company: 'Gama' }),
    ];
    for (const lead of leads) await addRun(automation.id, lead);
    expect(await cycle()).toMatchObject({ claimed: 3, sent: 3 });
    expect(
      textSends()
        .map((c) => (c.body as { text: string }).text)
        .sort(),
    ).toEqual(leads.map((l, i) => `Oi, ${l.name} (${['Alfa', 'Beta', 'Gama'][i]})`).sort());
  });

  it(`processa no máximo ${BATCH_SIZE} participações por ciclo`, async () => {
    const automation = await makeAutomation([{ text: 'Oi' }]);
    // Repartidas entre dois números: a execução manual também respeita a cota de 20 contatos por número por dia.
    for (let i = 0; i < BATCH_SIZE * 2 + 5; i++) {
      await addRun(automation.id, await newLead(), i % 2 === 0 ? n1 : n2);
    }
    expect((await cycle()).claimed).toBe(BATCH_SIZE);
    expect(textSends()).toHaveLength(BATCH_SIZE);
    expect((await cycle()).claimed).toBe(BATCH_SIZE);
    expect((await cycle()).claimed).toBe(5);
    expect(textSends()).toHaveLength(BATCH_SIZE * 2 + 5);
    expect((await cycle()).claimed).toBe(0);
  });

  it('cria a conversa quando o lead ainda não tem uma neste número (execução manual), sem duplicar', async () => {
    const automation = await makeAutomation([{ text: 'Primeira' }, { text: 'Segunda', delaySeconds: 60 }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead, n2);
    await cycle();
    await makeDue(runId);
    await cycle();
    const conversations = await t.db
      .selectFrom('wa_conversations')
      .select(['id', 'instance_id'])
      .where('lead_id', '=', lead.id)
      .execute();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.instance_id).toBe(n2);
    expect(textSends().map((c) => c.url)).toEqual([
      '/message/sendText/whatsapp-02',
      '/message/sendText/whatsapp-02',
    ]);
    // O telefone foi conferido uma vez, na primeira.
    expect(fake.calls.filter((c) => c.url.startsWith('/chat/whatsappNumbers/'))).toHaveLength(1);
  });
});

// ---------- 4. execução de áudio ----------

describe('execução: áudio', () => {
  it('envia o áudio ESCOLHIDO da biblioteca, grava a mensagem e liga ao step run', async () => {
    const chosen = await uploadAudio('Escolhido');
    await uploadAudio('Outro');
    const automation = await makeAutomation([{ audioId: chosen.id }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);
    await cycle();

    expect(audioSends()).toHaveLength(1);
    expect(textSends()).toHaveLength(0);
    expect(audioSends()[0]?.url).toBe('/message/sendWhatsAppAudio/whatsapp-01');
    expect((audioSends()[0]?.body as { audio: string } | undefined)?.audio).toBe(
      chosen.bytes.toString('base64'),
    );

    const [stepRun] = await stepRunsOf(runId);
    expect(stepRun).toMatchObject({ status: 'completed', attempts: 1 });
    const message = await t.db
      .selectFrom('wa_messages')
      .select(['id', 'type', 'from_me', 'media_path'])
      .where('id', '=', stepRun?.message_id ?? -1)
      .executeTakeFirstOrThrow();
    expect(message).toMatchObject({ type: 'audio', from_me: true });
    expect(message.media_path).toBeTruthy();
    expect((await runOf(runId)).status).toBe('completed');
  });

  it('áudio removido da biblioteca: a etapa falha com motivo legível e nada é enviado', async () => {
    const audio = await uploadAudio('Some');
    const automation = await makeAutomation([{ audioId: audio.id }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);
    await admin.post(`/api/audios/${audio.id}/delete`);
    expect(await cycle()).toMatchObject({ claimed: 1, failed: 1 });
    expect(sends()).toHaveLength(0);
    const run = await runOf(runId);
    expect(run).toMatchObject({ status: 'failed', cancel_reason: 'etapa_invalida' });
    expect((await stepRunsOf(runId))[0]).toMatchObject({ status: 'failed', message_id: null });
    expect((await stepRunsOf(runId))[0]?.error).toContain('áudio');
  });

  it('arquivo do áudio sumiu do disco: falha sem enviar e sem derrubar o ciclo', async () => {
    const audio = await uploadAudio('SemArquivo');
    const automation = await makeAutomation([{ audioId: audio.id }]);
    const good = await makeAutomation([{ text: 'Este continua saindo' }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);
    await addRun(good.id, await newLead());
    await t.db
      .updateTable('wa_audios')
      .set({ media_path: 'audios/nao-existe.ogg' })
      .where('id', '=', audio.id)
      .execute();
    expect(await cycle()).toMatchObject({ claimed: 2, failed: 1, sent: 1 });
    expect(audioSends()).toHaveLength(0);
    expect(textSends()).toHaveLength(1);
    expect((await runOf(runId)).cancel_reason).toBe('audio_indisponivel');
  });
});

// ---------- 5. duplicidade ----------

describe('duplicidade: uma etapa, uma mensagem', () => {
  it('rodar o worker duas vezes para o mesmo run envia uma única mensagem', async () => {
    const automation = await makeAutomation([{ text: 'Só uma vez' }, { text: 'Depois', delaySeconds: 3600 }]);
    const lead = await newLead();
    await addRun(automation.id, lead);
    await cycle();
    await cycle();
    expect(textSends()).toHaveLength(1);
  });

  it('três workers ao mesmo tempo para o mesmo run: uma única mensagem', async () => {
    const automation = await makeAutomation([{ text: 'Só uma vez' }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);
    const results = await Promise.all([cycle(), cycle(), cycle()]);
    expect(results.reduce((sum, r) => sum + r.claimed, 0)).toBe(1);
    expect(textSends()).toHaveLength(1);
    expect(await stepRunsOf(runId)).toHaveLength(1);
    expect((await runOf(runId)).status).toBe('completed');
  });

  it('vários workers e vários runs ao mesmo tempo: cada run recebe exatamente uma mensagem', async () => {
    const automation = await makeAutomation([{ text: 'Oi' }]);
    const runs: number[] = [];
    for (let i = 0; i < 6; i++) runs.push(await addRun(automation.id, await newLead()));
    await Promise.all([cycle(), cycle(), cycle(), cycle()]);
    expect(textSends()).toHaveLength(6);
    for (const runId of runs) expect(await stepRunsOf(runId)).toHaveLength(1);
  });

  it('a mesma etapa já enviada não é enviada de novo, mesmo que a participação volte a ficar vencida', async () => {
    const automation = await makeAutomation([{ text: 'Etapa um' }, { text: 'Etapa dois', delaySeconds: 60 }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);
    await cycle();
    expect(textSends()).toHaveLength(1);
    // Simula o processo que caiu ANTES de avançar: a participação volta para a etapa 1, vencida.
    await t.db
      .updateTable('automation_runs')
      .set({ current_step: 1, next_run_at: new Date(Date.now() - 1000) })
      .where('id', '=', runId)
      .execute();
    await cycle();
    expect(textSends()).toHaveLength(1); // nenhuma mensagem nova
    expect((await runOf(runId)).current_step).toBe(2); // só avançou
    expect(await stepRunsOf(runId)).toHaveLength(1);
  });
});

// ---------- 6. resposta do lead ----------

describe('resposta do lead cancela a automação', () => {
  it('a resposta chega pelo webhook: a participação é cancelada na hora e nada mais é enviado', async () => {
    const automation = await makeAutomation([{ text: 'Um' }, { text: 'Dois', delaySeconds: 3600 }]);
    const lead = await newLead();
    await linkConversation(lead, n1);
    const runId = await addRun(automation.id, lead);
    await cycle(); // etapa 1 enviada
    expect(textSends()).toHaveLength(1);
    await makeDue(runId); // a etapa 2 venceria agora

    expect((await reply(lead)).statusCode).toBe(200);
    const run = await runOf(runId);
    expect(run).toMatchObject({ status: 'cancelled', cancel_reason: 'lead_respondeu', next_run_at: null });
    expect(run.cancelled_at).toBeInstanceOf(Date);
    expect(await auditActions(automation.id)).toContain('cancelou_execucao_automacao');

    expect(await cycle()).toMatchObject({ claimed: 0, sent: 0 });
    expect(textSends()).toHaveLength(1); // a etapa 2 NÃO saiu
  });

  it('cancela só as participações daquele lead naquele número', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const other = await makeAutomation([{ text: 'Outra' }]);
    const lead = await newLead();
    const stranger = await newLead();
    await linkConversation(lead, n1);
    await linkConversation(stranger, n1);
    const cancelled = await addRun(automation.id, lead, n1, { next_run_at: new Date(Date.now() + 3600_000) });
    const otherAutomation = await addRun(other.id, lead, n1, {
      next_run_at: new Date(Date.now() + 3600_000),
    });
    const otherNumber = await addRun(other.id, await newLead(), n2, {
      next_run_at: new Date(Date.now() + 3600_000),
    });
    const otherLead = await addRun(automation.id, stranger, n1, {
      next_run_at: new Date(Date.now() + 3600_000),
    });

    await reply(lead, 'whatsapp-01');
    expect((await runOf(cancelled)).status).toBe('cancelled');
    expect((await runOf(otherAutomation)).status).toBe('cancelled'); // mesmo lead e número, outra automação
    expect((await runOf(otherNumber)).status).toBe('pending'); // outro lead, outro número
    expect((await runOf(otherLead)).status).toBe('pending'); // outro lead, mesmo número
  });

  it('resposta por OUTRO número não cancela a participação deste número', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const lead = await newLead();
    await linkConversation(lead, n1);
    await linkConversation(lead, n2);
    const runId = await addRun(automation.id, lead, n1, { next_run_at: new Date(Date.now() + 3600_000) });
    await reply(lead, 'whatsapp-02');
    expect((await runOf(runId)).status).toBe('pending');
  });

  it('a tentativa de etapa que ainda não começou também é cancelada', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const lead = await newLead();
    await linkConversation(lead, n1);
    const runId = await addRun(automation.id, lead, n1, { next_run_at: new Date(Date.now() + 3600_000) });
    await t.db
      .insertInto('automation_step_runs')
      .values({
        automation_run_id: runId,
        step_id: automation.stepIds[0] as number,
        scheduled_at: new Date(),
      })
      .execute();
    await reply(lead);
    expect((await stepRunsOf(runId))[0]?.status).toBe('cancelled');
  });

  it('rede de segurança: resposta que não passou pelo webhook também impede o envio', async () => {
    const automation = await makeAutomation([{ text: 'Não deve sair' }]);
    const lead = await newLead();
    const conversationId = await linkConversation(lead, n1);
    const runId = await addRun(automation.id, lead, n1, { started_at: new Date(Date.now() - 3600_000) });
    await t.db
      .insertInto('wa_messages')
      .values({
        instance_id: n1,
        conversation_id: conversationId,
        wa_id: `IMPORTADA-${++msgSeq}`,
        remote_jid: `${lead.phone}@s.whatsapp.net`,
        from_me: false,
        type: 'text',
        text: 'Respondi antes',
        sent_at: new Date(Date.now() - 1800_000), // depois do início da participação
      })
      .execute();
    expect(await cycle()).toMatchObject({ claimed: 1, cancelled: 1, sent: 0 });
    expect(sends()).toHaveLength(0);
    expect((await runOf(runId)).cancel_reason).toBe('lead_respondeu');
  });

  it('resposta ANTES do início da participação não cancela (é de outra conversa)', async () => {
    const automation = await makeAutomation([{ text: 'Sai normalmente' }]);
    const lead = await newLead();
    const conversationId = await linkConversation(lead, n1);
    await addRun(automation.id, lead, n1, { started_at: new Date(Date.now() - 60_000) });
    await t.db
      .insertInto('wa_messages')
      .values({
        instance_id: n1,
        conversation_id: conversationId,
        wa_id: `ANTIGA-${++msgSeq}`,
        remote_jid: `${lead.phone}@s.whatsapp.net`,
        from_me: false,
        type: 'text',
        text: 'Mensagem de semana passada',
        sent_at: new Date(Date.now() - 7 * 86_400_000),
      })
      .execute();
    expect(await cycle()).toMatchObject({ sent: 1 });
  });

  it('mensagem enviada por nós (from_me) não cancela nada', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const lead = await newLead();
    await linkConversation(lead, n1);
    const runId = await addRun(automation.id, lead, n1, { next_run_at: new Date(Date.now() + 3600_000) });
    await hook('send.message', {
      key: { id: `SAIU-${++msgSeq}`, remoteJid: `${lead.phone}@s.whatsapp.net`, fromMe: true },
      status: 'PENDING',
      message: { conversation: 'Enviada pelo sistema' },
      messageType: 'conversation',
      messageTimestamp: Math.floor(Date.now() / 1000),
    });
    expect((await runOf(runId)).status).toBe('pending');
  });
});

// ---------- 7. pausada, arquivada, bloqueio, exclusão ----------

describe('automação pausada e arquivada', () => {
  it('pausada: a participação espera, sem enviar e sem mudar nada; ao voltar a ativa, segue', async () => {
    const automation = await makeAutomation([{ text: 'Um' }, { text: 'Dois', delaySeconds: 60 }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);
    await cycle();
    expect(textSends()).toHaveLength(1);
    await makeDue(runId);
    const before = await runOf(runId);

    expect(
      (await admin.patch(`/api/automations/${automation.id}/status`, { status: 'paused' })).statusCode,
    ).toBe(200);
    expect(await cycle()).toMatchObject({ claimed: 0, sent: 0 });
    expect(textSends()).toHaveLength(1);
    const during = await runOf(runId);
    expect(during).toMatchObject({ status: 'pending', current_step: 2 });
    expect(during.next_run_at).toEqual(before.next_run_at);
    expect((await stepRunsOf(runId)).map((s) => s.status)).toEqual(['completed']); // histórico intacto

    await admin.patch(`/api/automations/${automation.id}/status`, { status: 'active' });
    expect(await cycle()).toMatchObject({ sent: 1, completed: 1 });
    expect(textSends()).toHaveLength(2);
  });

  it('arquivada: as participações pendentes são canceladas, com motivo, e o histórico fica', async () => {
    const automation = await makeAutomation([{ text: 'Um' }, { text: 'Dois', delaySeconds: 60 }]);
    const a = await addRun(automation.id, await newLead());
    const b = await addRun(automation.id, await newLead(), n1, {
      next_run_at: new Date(Date.now() + 3600_000),
    });
    await cycle(); // a envia a etapa 1
    const sentBefore = textSends().length;

    expect((await admin.post(`/api/automations/${automation.id}/archive`)).statusCode).toBe(200);
    for (const id of [a, b]) {
      const run = await runOf(id);
      expect(run).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'automacao_arquivada',
        next_run_at: null,
      });
    }
    expect((await stepRunsOf(a)).map((s) => s.status)).toEqual(['completed']); // histórico mantido
    expect(await cycle()).toMatchObject({ claimed: 0 });
    expect(textSends()).toHaveLength(sentBefore);
    const summary = (await auditActions(automation.id)).filter((x) => x === 'arquivou_automacao');
    expect(summary).toHaveLength(1);
  });

  it('arquivada não recebe participação nova (nem manual, nem pelo Chamar)', async () => {
    await uploadAudio('A');
    const automation = await makeAutomation([{ text: 'Um' }], { trigger: 'lead_called' });
    await admin.post(`/api/automations/${automation.id}/archive`);
    const lead = await newLead();
    expect(
      (await ana.post(`/api/leads/${lead.id}/conversation`, { instanceId: n1, sendAudio: true })).statusCode,
    ).toBe(200);
    expect(await t.db.selectFrom('automation_runs').select('id').execute()).toEqual([]);
  });

  it('participação de automação arquivada por fora (sem passar pela API) também é cancelada no ciclo', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const runId = await addRun(automation.id, await newLead());
    await t.db
      .updateTable('automations')
      .set({ status: 'archived', archived_at: new Date() })
      .where('id', '=', automation.id)
      .execute();
    expect(await cycle()).toMatchObject({ sent: 0 });
    expect(sends()).toHaveLength(0);
    expect((await runOf(runId)).cancel_reason).toBe('automacao_arquivada');
  });
});

describe('lead bloqueado, anonimizado ou excluído', () => {
  it('"não contatar" (bloqueio) cancela na hora as participações do lead', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead, n1, { next_run_at: new Date(Date.now() + 3600_000) });
    const r = await admin.post('/api/blocklist', { phone: lead.phone });
    expect(r.statusCode, r.body).toBe(200);
    expect(await runOf(runId)).toMatchObject({ status: 'cancelled', cancel_reason: 'lead_bloqueado' });
    await makeDue(runId); // (não muda nada: já está cancelada)
    expect(await cycle()).toMatchObject({ claimed: 0 });
    expect(sends()).toHaveLength(0);
  });

  it('o próprio lead pedindo para não ser contatado (opt-out) também cancela', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead, n1, { next_run_at: new Date(Date.now() + 3600_000) });
    expect((await ana.post(`/api/leads/${lead.id}/optout`, {})).statusCode).toBe(200);
    expect((await runOf(runId)).cancel_reason).toBe('lead_bloqueado');
  });

  it('rede de segurança: telefone na lista de bloqueio que não cancelou a participação ainda assim não recebe', async () => {
    const automation = await makeAutomation([{ text: 'Não deve sair' }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);
    await t.db.insertInto('blocked_phones').values({ phone: lead.phone, reason: 'teste' }).execute();
    expect(await cycle()).toMatchObject({ claimed: 1, cancelled: 1, sent: 0 });
    expect(sends()).toHaveLength(0);
    expect((await runOf(runId)).cancel_reason).toBe('lead_bloqueado');
    expect(await auditActions(automation.id)).toContain('cancelou_execucao_automacao');
  });

  it('lead anonimizado (LGPD) não recebe', async () => {
    const automation = await makeAutomation([{ text: 'Não deve sair' }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);
    await t.db
      .updateTable('leads')
      .set({ anonymized_at: new Date(), phone: '', name: 'Titular anonimizado' })
      .where('id', '=', lead.id)
      .execute();
    expect(await cycle()).toMatchObject({ sent: 0, cancelled: 1 });
    expect(sends()).toHaveLength(0);
    expect((await runOf(runId)).cancel_reason).toBe('lead_anonimizado');
  });

  it('lead excluído: as participações e as tentativas somem junto, e o ciclo segue sem erro', async () => {
    const automation = await makeAutomation([{ text: 'Um' }, { text: 'Dois', delaySeconds: 60 }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);
    await cycle();
    expect((await stepRunsOf(runId)).length).toBe(1);
    await t.db.deleteFrom('leads').where('id', '=', lead.id).execute();
    expect(await t.db.selectFrom('automation_runs').select('id').where('id', '=', runId).execute()).toEqual(
      [],
    );
    expect(await stepRunsOf(runId)).toEqual([]);
    expect(await cycle()).toMatchObject({ claimed: 0 });
  });
});

// ---------- 8. número desconectado / removido ----------

describe('número desconectado ou removido', () => {
  it('desconectado: a participação espera (pendente), nada é enviado nem consultado; quando volta, envia', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);
    await hook('connection.update', { state: 'close' }, 'whatsapp-01');
    expect(await cycle()).toMatchObject({ claimed: 0, sent: 0 });
    expect(fake.calls).toEqual([]); // nem a Evolution é consultada
    expect(await runOf(runId)).toMatchObject({ status: 'pending', current_step: 1 });

    await hook('connection.update', { state: 'open' }, 'whatsapp-01');
    expect(await cycle()).toMatchObject({ sent: 1, completed: 1 });
    expect(textSends()).toHaveLength(1);
  });

  it('só as participações do número desconectado esperam; as do outro seguem', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const stuck = await addRun(automation.id, await newLead(), n1);
    const fine = await addRun(automation.id, await newLead(), n2);
    await hook('connection.update', { state: 'close' }, 'whatsapp-01');
    expect(await cycle()).toMatchObject({ claimed: 1, sent: 1 });
    expect(textSends()[0]?.url).toBe('/message/sendText/whatsapp-02');
    expect((await runOf(stuck)).status).toBe('pending');
    expect((await runOf(fine)).status).toBe('completed');
  });

  it('a Evolution recusa por desconexão: nada saiu, tenta de novo depois (sem laço rápido) e depois envia', async () => {
    const automation = await makeAutomation([{ text: 'Um' }, { text: 'Dois', delaySeconds: 60 }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);
    fake.failSends = { status: 400, message: 'Connection Closed' };
    expect(await cycle()).toMatchObject({ claimed: 1, rescheduled: 1, sent: 0 });
    expect(textSends()).toHaveLength(1); // uma tentativa recusada
    let run = await runOf(runId);
    expect(run).toMatchObject({ status: 'pending', current_step: 1 });
    near(run.next_run_at, Date.now() + RETRY_SECONDS * 1000);
    expect((await stepRunsOf(runId))[0]).toMatchObject({ status: 'pending', attempts: 1 });

    // Sem esperar, o próximo ciclo não repete (a espera ainda não passou).
    expect(await cycle()).toMatchObject({ claimed: 0 });
    expect(textSends()).toHaveLength(1);

    // Passa a espera e o número volta: nova tentativa (a 2ª), agora enviada.
    fake.failSends = null;
    await makeDue(runId);
    expect(await cycle()).toMatchObject({ sent: 1 });
    run = await runOf(runId);
    expect(run.current_step).toBe(2);
    expect((await stepRunsOf(runId))[0]).toMatchObject({ status: 'completed', attempts: 2 });
  });

  it(`depois de ${MAX_ATTEMPTS} tentativas recusadas por desconexão, a etapa falha (não fica eterno)`, async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const runId = await addRun(automation.id, await newLead());
    fake.failSends = { status: 400, message: 'Connection Closed' };
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await cycle();
      await makeDue(runId);
    }
    const run = await runOf(runId);
    expect(run).toMatchObject({ status: 'failed', cancel_reason: 'tentativas_esgotadas', next_run_at: null });
    expect((await stepRunsOf(runId))[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect(textSends()).toHaveLength(MAX_ATTEMPTS);
  });

  it('número excluído (participação sem número): cancela, não escolhe outro', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const runId = await addRun(automation.id, await newLead(), null);
    expect(await cycle()).toMatchObject({ sent: 0 });
    expect(sends()).toHaveLength(0);
    expect((await runOf(runId)).cancel_reason).toBe('numero_removido');
  });
});

// ---------- 9. condições ----------

describe('condições da etapa', () => {
  it('condição verdadeira: envia', async () => {
    const automation = await makeAutomation([
      { text: 'Vale', conditions: [{ field: 'lead_status', operator: 'is', value: 'pendente' }] },
    ]);
    await addRun(automation.id, await newLead());
    expect(await cycle()).toMatchObject({ sent: 1, skipped: 0 });
    expect(textSends()).toHaveLength(1);
  });

  it('condição falsa: NÃO envia, marca "skipped" com a explicação, e segue para a próxima com a espera dela', async () => {
    const automation = await makeAutomation([
      { text: 'Pula', conditions: [{ field: 'lead_result', operator: 'is', value: 'interessado' }] },
      { text: 'Segue', delaySeconds: 7200 },
    ]);
    const runId = await addRun(automation.id, await newLead());
    expect(await cycle()).toMatchObject({ claimed: 1, skipped: 1, sent: 0 });
    expect(sends()).toHaveLength(0);
    const [skipped] = await stepRunsOf(runId);
    expect(skipped).toMatchObject({ status: 'skipped', attempts: 0, message_id: null, position: 1 });
    expect(skipped?.error).toContain('Resultado do lead é Interessado');
    const run = await runOf(runId);
    expect(run).toMatchObject({ status: 'pending', current_step: 2 });
    near(run.next_run_at, Date.now() + 7200_000);
    expect(await auditActions(automation.id)).toContain('pulou_etapa_automacao');

    await makeDue(runId);
    await cycle();
    expect(textSends().map((c) => (c.body as { text: string }).text)).toEqual(['Segue']);
    expect((await runOf(runId)).status).toBe('completed');
  });

  it('etapa pulada NÃO é falha: se a última é pulada, a participação termina "completed"', async () => {
    const automation = await makeAutomation([
      { text: 'Última', conditions: [{ field: 'lead_replied', operator: 'is', value: true }] },
    ]);
    const runId = await addRun(automation.id, await newLead());
    expect(await cycle()).toMatchObject({ skipped: 1, completed: 1, failed: 0 });
    const run = await runOf(runId);
    expect(run).toMatchObject({ status: 'completed', next_run_at: null });
    expect(run.completed_at).toBeInstanceOf(Date);
    expect(sends()).toHaveLength(0);
  });

  it('várias condições: todas precisam valer (E), com is e is_not', async () => {
    const lead = await newLead();
    await t.db
      .updateTable('leads')
      .set({ result: 'interessado', status: 'chamado', called_at: new Date(), called_by: anaId })
      .where('id', '=', lead.id)
      .execute();
    const passes = await makeAutomation([
      {
        text: 'Passa',
        conditions: [
          { field: 'lead_result', operator: 'is', value: 'interessado' },
          { field: 'lead_status', operator: 'is', value: 'chamado' },
          { field: 'lead_replied', operator: 'is_not', value: true },
        ],
      },
    ]);
    const fails = await makeAutomation([
      {
        text: 'Falha',
        conditions: [
          { field: 'lead_result', operator: 'is', value: 'interessado' },
          { field: 'lead_status', operator: 'is_not', value: 'chamado' },
        ],
      },
    ]);
    await addRun(passes.id, lead);
    await addRun(fails.id, lead);
    expect(await cycle()).toMatchObject({ claimed: 2, sent: 1, skipped: 1 });
    expect(textSends().map((c) => (c.body as { text: string }).text)).toEqual(['Passa']);
  });

  it('condição por lista: vale só para leads daquela lista', async () => {
    const lead = await newLead();
    const listId = (
      await t.db.selectFrom('leads').select('list_id').where('id', '=', lead.id).executeTakeFirstOrThrow()
    ).list_id;
    const inList = await makeAutomation([
      { text: 'Da lista', conditions: [{ field: 'lead_list', operator: 'is', value: listId }] },
    ]);
    const otherList = (await seedList(t.db, { count: 1, phoneStart: phoneSeq++ })).listId;
    const notInList = await makeAutomation([
      { text: 'Outra lista', conditions: [{ field: 'lead_list', operator: 'is', value: otherList }] },
    ]);
    await addRun(inList.id, lead);
    await addRun(notInList.id, lead);
    expect(await cycle()).toMatchObject({ sent: 1, skipped: 1 });
    expect(textSends().map((c) => (c.body as { text: string }).text)).toEqual(['Da lista']);
  });
});

// ---------- 10. falhas e retries ----------

describe('falhas: nada de reenvio no escuro', () => {
  it('a Evolution recusa (400): falha, sem tentar de novo', async () => {
    const automation = await makeAutomation([{ text: 'Um' }, { text: 'Dois', delaySeconds: 60 }]);
    const runId = await addRun(automation.id, await newLead());
    fake.failSends = { status: 400, message: 'número inválido' };
    expect(await cycle()).toMatchObject({ claimed: 1, failed: 1 });
    expect(await runOf(runId)).toMatchObject({
      status: 'failed',
      cancel_reason: 'envio_recusado',
      next_run_at: null,
    });
    const [stepRun] = await stepRunsOf(runId);
    expect(stepRun).toMatchObject({ status: 'failed', attempts: 1, message_id: null });
    expect(stepRun?.error).toContain('recusou');
    fake.failSends = null;
    await cycle();
    await cycle();
    expect(textSends()).toHaveLength(1); // nunca reenviou
  });

  it('erro 5xx: resultado incerto — falha e NÃO reenvia', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const runId = await addRun(automation.id, await newLead());
    fake.failSends = { status: 500, message: 'Internal error' };
    await cycle();
    expect(await runOf(runId)).toMatchObject({ status: 'failed', cancel_reason: 'resultado_incerto' });
    expect((await stepRunsOf(runId))[0]?.error).toContain('reenviada');
    fake.failSends = null;
    await makeDue(runId);
    await cycle();
    await cycle();
    expect(textSends()).toHaveLength(1);
  });

  it('variável que não existe: falha sem enviar (não manda "{{nomee}}" para o cliente)', async () => {
    const automation = await makeAutomation([{ text: 'Oi {{nomee}}!' }]);
    const runId = await addRun(automation.id, await newLead());
    expect(await cycle()).toMatchObject({ failed: 1 });
    expect(sends()).toHaveLength(0);
    expect(await runOf(runId)).toMatchObject({ status: 'failed', cancel_reason: 'variavel_desconhecida' });
    expect((await stepRunsOf(runId))[0]?.error).toContain('{{nomee}}');
  });

  it('telefone sem WhatsApp (confirmado pela Evolution ao abrir a conversa): falha sem enviar', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const lead = await newLead();
    await t.db.updateTable('leads').set({ phone: '5541988889999' }).where('id', '=', lead.id).execute();
    const runId = await addRun(automation.id, lead);
    expect(await cycle()).toMatchObject({ failed: 1 });
    expect(sends()).toHaveLength(0);
    expect((await runOf(runId)).cancel_reason).toBe('sem_whatsapp');
  });

  it('etapa excluída no meio: o que sobra segue; sem mais etapas, a participação termina', async () => {
    const automation = await makeAutomation([{ text: 'Um' }, { text: 'Dois', delaySeconds: 60 }]);
    const runId = await addRun(automation.id, await newLead());
    await cycle();
    await t.db
      .deleteFrom('automation_steps')
      .where('id', '=', automation.stepIds[1] as number)
      .execute();
    await makeDue(runId);
    expect(await cycle()).toMatchObject({ completed: 1, sent: 0 });
    expect((await runOf(runId)).status).toBe('completed');
    expect(textSends()).toHaveLength(1);
  });
});

// ---------- 11. travados e reinício ----------

describe('participações travadas e reinício', () => {
  it('processo que caiu no meio do envio: a tentativa vira falha "executor_interrompido" e NÃO é reenviada', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const runId = await addRun(automation.id, await newLead());
    // O estado que um processo morto deixa: participação e tentativa "running", há muito tempo.
    await t.db
      .updateTable('automation_runs')
      .set({ status: 'running', updated_at: new Date(Date.now() - 30 * 60_000) })
      .where('id', '=', runId)
      .execute();
    await t.db
      .insertInto('automation_step_runs')
      .values({
        automation_run_id: runId,
        step_id: automation.stepIds[0] as number,
        status: 'running',
        attempts: 1,
        scheduled_at: new Date(),
        started_at: new Date(Date.now() - 30 * 60_000),
      })
      .execute();
    expect(await cycle()).toMatchObject({ claimed: 0, sent: 0 });
    expect(sends()).toHaveLength(0);
    expect(await runOf(runId)).toMatchObject({
      status: 'failed',
      cancel_reason: 'executor_interrompido',
      next_run_at: null,
    });
    const [stepRun] = await stepRunsOf(runId);
    expect(stepRun).toMatchObject({ status: 'failed', attempts: 1 });
    expect(stepRun?.error).toContain('não foi reenviada');
    expect(await auditActions(automation.id)).toContain('falhou_execucao_automacao');
    await cycle();
    expect(sends()).toHaveLength(0); // continua sem reenviar
  });

  it('participação "running" recente (outro worker trabalhando agora) não é mexida', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const runId = await addRun(automation.id, await newLead());
    await t.db
      .updateTable('automation_runs')
      .set({ status: 'running', updated_at: new Date() })
      .where('id', '=', runId)
      .execute();
    expect(await cycle()).toMatchObject({ claimed: 0 });
    expect((await runOf(runId)).status).toBe('running');
  });

  it('tentativa "running" sem o processo (participação vencida de novo): falha sem enviar', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const runId = await addRun(automation.id, await newLead());
    await t.db
      .insertInto('automation_step_runs')
      .values({
        automation_run_id: runId,
        step_id: automation.stepIds[0] as number,
        status: 'running',
        attempts: 1,
        scheduled_at: new Date(),
      })
      .execute();
    expect(await cycle()).toMatchObject({ claimed: 1, failed: 1 });
    expect(sends()).toHaveLength(0);
    expect((await runOf(runId)).cancel_reason).toBe('executor_interrompido');
  });

  it('reinício: a participação salva no PostgreSQL é encontrada por um processo novo, sem depender de memória', async () => {
    const automation = await makeAutomation([{ text: 'Depois do reinício' }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);
    // "Processo novo": outra conexão com o banco, sem nada em memória do anterior.
    const freshPool = createPool(t.url, 2);
    const freshDb = createDb(freshPool);
    try {
      const result = await runAutomationCycle(freshDb);
      expect(result).toMatchObject({ claimed: 1, sent: 1 });
    } finally {
      await freshDb.destroy();
    }
    expect(textSends()).toHaveLength(1);
    expect((await runOf(runId)).status).toBe('completed');
  });
});

// ---------- 12. execução manual ----------

describe('gatilho manual: POST /api/automations/:id/run', () => {
  const run = (automationId: number, body: unknown, who: Client = admin) =>
    who.post(`/api/automations/${automationId}/run`, body);

  it('só quem gerencia automações; um lead por pedido, com validação do corpo', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const lead = await newLead();
    expect((await run(automation.id, { leadId: lead.id, instanceId: n1 }, ana)).statusCode).toBe(403);
    for (const body of [
      {},
      { leadId: lead.id },
      { instanceId: n1 },
      { leadId: 'x', instanceId: n1 },
      { leadIds: [lead.id], instanceId: n1 },
    ]) {
      expect((await run(automation.id, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await t.db.selectFrom('automation_runs').select('id').execute()).toEqual([]);
  });

  it('inicia a participação com o número escolhido, audita, e o executor envia por esse número', async () => {
    const automation = await makeAutomation([{ text: 'Manual para {{nome}}', delaySeconds: 0 }]);
    const lead = await newLead();
    const r = await run(automation.id, { leadId: lead.id, instanceId: n2 });
    expect(r.statusCode, r.body).toBe(201);
    const item: AutomationRunItem = r.json();
    expect(item).toMatchObject({
      automationId: automation.id,
      status: 'pending',
      currentStep: 1,
      lead: { id: lead.id },
      instance: { id: n2 },
    });
    const row = await t.db
      .selectFrom('automation_runs')
      .selectAll()
      .where('id', '=', item.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ instance_id: n2, lead_id: lead.id, status: 'pending', current_step: 1 });
    expect(row.started_by).not.toBeNull();
    near(row.next_run_at, Date.now());
    expect(await auditActions(automation.id)).toContain('iniciou_execucao_manual');
    expect(sends()).toHaveLength(0); // criar não envia; quem envia é o ciclo

    await cycle();
    expect(textSends()).toHaveLength(1);
    expect(textSends()[0]?.url).toBe('/message/sendText/whatsapp-02');
    expect(textOf(textSends()[0])).toBe(`Manual para ${lead.name}`);
  });

  it('respeita a espera da primeira etapa', async () => {
    const automation = await makeAutomation([{ text: 'Depois', delaySeconds: 3600 }]);
    const lead = await newLead();
    const item: AutomationRunItem = (await run(automation.id, { leadId: lead.id, instanceId: n1 })).json();
    near(item.nextRunAt ? new Date(item.nextRunAt) : null, Date.now() + 3600_000);
    expect(await cycle()).toMatchObject({ claimed: 0 });
  });

  it('não permite duas participações simultâneas do mesmo lead na mesma automação', async () => {
    const automation = await makeAutomation([{ text: 'Um' }, { text: 'Dois', delaySeconds: 60 }]);
    const lead = await newLead();
    expect((await run(automation.id, { leadId: lead.id, instanceId: n1 })).statusCode).toBe(201);
    const again = await run(automation.id, { leadId: lead.id, instanceId: n1 });
    expect(again.statusCode).toBe(409);
    // Dois pedidos ao mesmo tempo: só um passa (o índice único decide).
    const other = await newLead();
    const both = await Promise.all([
      run(automation.id, { leadId: other.id, instanceId: n1 }),
      run(automation.id, { leadId: other.id, instanceId: n1 }),
    ]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it('recusa: automação inexistente, arquivada, pausada, rascunho ou de outro gatilho', async () => {
    const lead = await newLead();
    const body = { leadId: lead.id, instanceId: n1 };
    expect((await run(999_999, body)).statusCode).toBe(404);
    const draft = await makeAutomation([{ text: 'a' }], { status: 'draft' });
    const paused = await makeAutomation([{ text: 'b' }], { status: 'paused' });
    const called = await makeAutomation([{ text: 'c' }], { trigger: 'lead_called' });
    const archived = await makeAutomation([{ text: 'd' }]);
    await admin.post(`/api/automations/${archived.id}/archive`);
    for (const a of [draft, paused, called, archived]) {
      expect((await run(a.id, body)).statusCode, String(a.id)).toBe(409);
    }
    expect(await t.db.selectFrom('automation_runs').select('id').execute()).toEqual([]);
  });

  it('recusa: lead ou número inexistente, número desconectado, lead bloqueado ou anonimizado', async () => {
    const automation = await makeAutomation([{ text: 'Um' }]);
    const lead = await newLead();
    expect((await run(automation.id, { leadId: 999_999, instanceId: n1 })).statusCode).toBe(404);
    expect((await run(automation.id, { leadId: lead.id, instanceId: 999_999 })).statusCode).toBe(404);

    await hook('connection.update', { state: 'close' }, 'whatsapp-02');
    fake.closed.add('whatsapp-02');
    expect((await run(automation.id, { leadId: lead.id, instanceId: n2 })).statusCode).toBe(409);

    const blocked = await newLead();
    await admin.post('/api/blocklist', { phone: blocked.phone });
    expect((await run(automation.id, { leadId: blocked.id, instanceId: n1 })).statusCode).toBe(409);

    const anonymous = await newLead();
    await t.db
      .updateTable('leads')
      .set({ anonymized_at: new Date(), phone: '' })
      .where('id', '=', anonymous.id)
      .execute();
    expect((await run(automation.id, { leadId: anonymous.id, instanceId: n1 })).statusCode).toBe(409);
    expect(await t.db.selectFrom('automation_runs').select('id').execute()).toEqual([]);
  });

  it('lista as participações de uma automação (diagnóstico)', async () => {
    const automation = await makeAutomation([{ text: 'Um' }, { text: 'Dois', delaySeconds: 60 }]);
    const lead = await newLead();
    const item: AutomationRunItem = (await run(automation.id, { leadId: lead.id, instanceId: n1 })).json();
    await cycle();
    const runs = (await admin.get(`/api/automations/${automation.id}/runs`)).json() as AutomationRunItem[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: item.id, status: 'pending', currentStep: 2 });
    expect(runs[0]?.steps).toEqual([
      expect.objectContaining({
        position: 1,
        status: 'completed',
        attempts: 1,
        messageId: expect.any(Number),
      }),
    ]);
    const detail = (await admin.get(`/api/automations/${automation.id}`)).json() as AutomationItem;
    expect(detail.runs).toMatchObject({ pending: 1, completed: 0 });
    expect(detail.lastRunAt).not.toBeNull();
    expect((await admin.get('/api/automations/999999/runs')).statusCode).toBe(404);
    expect((await ana.get(`/api/automations/${automation.id}/runs`)).statusCode).toBe(403);
  });
});

// ---------- 13. o que o executor não faz ----------

describe('segurança do executor', () => {
  it('rascunho e "lead_created" não ativam (o gatilho ainda não está ligado)', async () => {
    const created = await admin.post('/api/automations', {
      name: `Criado ${++msgSeq}`,
      trigger: 'lead_created',
    });
    const id = (created.json() as AutomationItem).id;
    await admin.post(`/api/automations/${id}/steps`, {
      actionType: 'send_text',
      delaySeconds: 0,
      messageText: 'Oi',
      conditions: [],
    });
    const r = await admin.patch(`/api/automations/${id}/status`, { status: 'active' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('ainda não está ligado');
  });

  it('sem a Evolution configurada o ciclo não faz nada', async () => {
    const { configureEvolution } = await import('../../src/server/modules/whatsapp/evolution');
    const automation = await makeAutomation([{ text: 'Um' }]);
    await addRun(automation.id, await newLead());
    const saved = t.app.config;
    configureEvolution({ ...saved, EVOLUTION_URL: null });
    try {
      expect(await cycle()).toMatchObject({ claimed: 0, sent: 0 });
    } finally {
      configureEvolution(saved);
    }
    expect(sends()).toHaveLength(0);
    expect(await cycle()).toMatchObject({ sent: 1 }); // com a Evolution de volta, envia
  });
});

// ---------- 14. o job do scheduler existente ----------

describe('scheduler: um único job para todas as automações', () => {
  it('startJobs registra UM intervalo de automações; o tick executa o ciclo e a mensagem sai', async () => {
    const automation = await makeAutomation([{ text: 'Enviada pelo job' }]);
    const lead = await newLead();
    const runId = await addRun(automation.id, lead);

    // Captura os timers do scheduler sem deixar nenhum rodar de verdade (nada de esperar o relógio).
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const timeouts = vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => ({ unref() {} })) as never);
    let stop = () => {};
    try {
      stop = startJobs(t.db, t.app.log);
    } finally {
      timeouts.mockRestore();
    }
    try {
      const automationTicks = intervals.mock.calls.filter(([, ms]) => ms === CYCLE_SECONDS * 1000);
      expect(automationTicks).toHaveLength(1); // um só, e não um por lead ou por etapa
      const tick = automationTicks[0]?.[0] as () => void;
      expect(sends()).toHaveLength(0);
      tick(); // o que o setInterval faria a cada CYCLE_SECONDS
      await vi.waitFor(() => expect(textSends()).toHaveLength(1), { timeout: 15_000 });
      expect(textOf(textSends()[0])).toBe('Enviada pelo job');
      await vi.waitFor(async () => expect((await runOf(runId)).status).toBe('completed'));
    } finally {
      stop();
      intervals.mockRestore();
    }
  });
});
