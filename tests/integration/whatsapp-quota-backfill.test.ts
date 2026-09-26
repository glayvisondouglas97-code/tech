import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool } from '../../src/server/db';
import {
  down as backfillDown,
  up as backfillMigration,
  backfillQuotaDay,
} from '../../src/server/db/migrations/0015_backfill_cota_diaria';
import { previewCampaign } from '../../src/server/modules/automations/campaigns';
import { runAutomationCycle } from '../../src/server/modules/automations/executor';
import { claimContactQuota, instanceUsage, quotaDate } from '../../src/server/modules/whatsapp/quota';
import type { InstanceInfo } from '../../src/shared/conversations';
import { at, campaignKit, DAY, NEXT_DAY, type StepSpec } from '../campaign-kit';
import { createUser, loginAs } from '../helpers';

// Backfill da cota do dia da instalação (migração 0015): reconstrói o uso do dia a partir do que o sistema já gravou
// (mensagens, conversas ligadas a leads, etapas de automação), SÓ desse dia. Os cenários são montados pelos caminhos REAIS
// (botão Chamar, mensagem digitada, /run, campanha, webhook), depois a cota do dia é apagada (o estado "antes da migração")
// e o backfill tem que devolver o que o sistema contou ao vivo.

const k = campaignKit();
const LIMIT_MESSAGE = 'Este número já atingiu o limite de 20 contatos hoje.';

let audioReady = false;
let seq = 0;
beforeEach(async () => {
  // Cada teste começa sem histórico de mensagens: o backfill lê exatamente isso.
  await k.t.db.deleteFrom('wa_messages').execute();
  await k.t.db.deleteFrom('wa_conversations').execute();
  await k.t.db.deleteFrom('wa_contacts').execute();
  audioReady = false;
});

const today = () => quotaDate(new Date());
const n0 = () => k.numbers[0];
const n1 = () => k.numbers[1];
const n2 = () => k.numbers[2];
const chamar = (leadId: number, instanceId: number, sendAudio = true) =>
  k.ana.post(`/api/leads/${leadId}/conversation`, { instanceId, sendAudio });
const runIt = (automationId: number, leadId: number, instanceId: number) =>
  k.admin.post(`/api/automations/${automationId}/run`, { leadId, instanceId });
const cycle = (seconds = 5, db = k.t.db) =>
  runAutomationCycle(db, { now: new Date(Date.now() + seconds * 1000), batchSize: 50 });
const wipeUsage = () => k.t.db.deleteFrom('wa_instance_daily_usage').execute();
const backfill = (day = today()) => backfillQuotaDay(k.t.db, day);
const use = (instance: number, day = today()) => k.usageRow(instance, day);

async function ensureAudio() {
  if (!audioReady) await k.uploadAudio('Apresentação');
  audioReady = true;
}

/** `count` primeiros contatos MANUAIS (botão Chamar com áudio) pelo número. */
async function manualContacts(count: number, instanceId: number) {
  await ensureAudio();
  const list = await k.newList(count, { assignTo: k.anaId });
  for (const id of list.leadIds) {
    const r = await chamar(id, instanceId);
    expect(r.statusCode, r.body).toBe(200);
  }
  return list;
}

/** `count` primeiros contatos AUTOMÁTICOS (/run, gatilho manual) pelo número. */
async function autoContacts(count: number, instanceId: number, steps: StepSpec[] = [{ text: 'Olá!' }]) {
  const automationId = await k.makeAutomation(steps);
  const list = await k.newList(count);
  for (const id of list.leadIds) {
    const r = await runIt(automationId, id, instanceId);
    expect(r.statusCode, r.body).toBe(201);
  }
  await cycle(5);
  return { automationId, list };
}

/** Move o horário de TODAS as mensagens para o dia `day` (a ordem entre elas é mantida). */
async function shiftMessagesTo(day: string) {
  await sql`UPDATE wa_messages SET sent_at = ${at(12, 0, 0, day)}::timestamptz
    + (id - (SELECT min(id) FROM wa_messages)) * interval '1 second'`.execute(k.t.db);
}

const messageOf = async (leadId: number) =>
  k.t.db
    .selectFrom('wa_messages as m')
    .innerJoin('wa_conversations as c', 'c.id', 'm.conversation_id')
    .select(['m.id', 'm.sent_at', 'm.from_me', 'm.sent_by'])
    .where('c.lead_id', '=', leadId)
    .orderBy('m.id')
    .execute();

/** Envios feitos ao telefone (texto ou áudio), na ordem. */
const sentTo = (phone: string) =>
  k.fake.calls.filter(
    (c) => c.url.startsWith('/message/send') && String((c.body as { number: string }).number).includes(phone),
  );

async function receivedFrom(phone: string, instanceName: string) {
  const r = await k.reply(phone, instanceName);
  expect(r.statusCode, r.body).toBe(200);
}

/** Mensagem enviada direto pelo celular (o webhook do WhatsApp: `fromMe`, sem ninguém do sistema por trás). */
async function sentFromPhone(phone: string, instanceName: string) {
  const r = await k.hook(
    'messages.upsert',
    {
      key: { id: `OUT-${++seq}`, remoteJid: `${phone}@s.whatsapp.net`, fromMe: true },
      status: 'SERVER_ACK',
      message: { conversation: 'Mandei pelo celular' },
      messageType: 'conversation',
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
    instanceName,
  );
  expect(r.statusCode, r.body).toBe(200);
}

async function leadCalledAutomation(text: string) {
  const created = await k.admin.post('/api/automations', {
    name: `Depois do Chamar ${++seq}`,
    trigger: 'lead_called',
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as number;
  const step = await k.admin.post(`/api/automations/${id}/steps`, {
    actionType: 'send_text',
    delaySeconds: 0,
    messageText: text,
    audioId: null,
    audioMode: 'fixed',
    conditions: [],
  });
  expect(step.statusCode, step.body).toBe(201);
  expect((await k.admin.patch(`/api/automations/${id}/status`, { status: 'active' })).statusCode).toBe(200);
  return id;
}

// ---------- o cenário do briefing ----------

describe('backfill: o dia da instalação não começa em 0/20', () => {
  it('7 manuais + 5 automáticos = 12/20 no dia: depois do backfill fica 7/5/12, restam 8 (nunca 0/20)', async () => {
    await manualContacts(7, n0());
    await autoContacts(5, n0());
    // O que o sistema contou ao vivo é a "verdade" a reproduzir.
    expect(await use(n0())).toEqual({ manual: 7, automatic: 5, uncertain: 0, total: 12 });

    await wipeUsage(); // o estado "antes da migração da cota": a tabela não existia
    expect(await use(n0())).toEqual({ manual: 0, automatic: 0, uncertain: 0, total: 0 });
    expect(await backfill()).toBe(1);

    expect(await use(n0())).toEqual({ manual: 7, automatic: 5, uncertain: 0, total: 12 });
    const usage = (await instanceUsage(k.t.db, [n0()], today())).get(n0());
    expect(usage).toMatchObject({ manual: 7, automatic: 5, total: 12, remaining: 8, limitReached: false });
    // A tela (Números) recebe o mesmo do servidor.
    const rows = (await k.admin.get('/api/instances')).json() as InstanceInfo[];
    expect(rows.find((r) => r.id === n0())?.usage).toMatchObject({
      manual: 7,
      automatic: 5,
      total: 12,
      remaining: 8,
      limit: 20,
    });
    // Os outros números não têm contato nenhum: continuam sem linha.
    expect(await use(n1())).toMatchObject({ total: 0 });
  });

  it('vários números: 12, 19 e 3 contatos → 12/20, 19/20 e 3/20', async () => {
    await manualContacts(12, n0());
    await manualContacts(19, n1());
    await manualContacts(3, n2());
    await wipeUsage();
    expect(await backfill()).toBe(3);
    expect(await use(n0())).toEqual({ manual: 12, automatic: 0, uncertain: 0, total: 12 });
    expect(await use(n1())).toEqual({ manual: 19, automatic: 0, uncertain: 0, total: 19 });
    expect(await use(n2())).toEqual({ manual: 3, automatic: 0, uncertain: 0, total: 3 });
  });
});

// ---------- o que conta e o que NÃO conta ----------

describe('backfill: só o primeiro contato identificável (a definição oficial)', () => {
  it('conta só o que é claramente primeiro contato; resposta, continuação, celular, follow-up e outros dias ficam de fora', async () => {
    await ensureAudio();
    const name = k.names[0];
    const followUp = await k.makeAutomation([
      { text: 'Primeiro' },
      { text: 'Acompanhamento', delaySeconds: 1 },
    ]);
    await leadCalledAutomation('Obrigado pelo contato!');

    // A: Chamar com áudio (CONTA, manual). Depois o lead responde e a atendente continua a conversa (não contam).
    const a = await k.newList(1, { assignTo: k.anaId });
    expect((await chamar(a.leadIds[0] as number, n0())).statusCode).toBe(200);
    await receivedFrom(a.phones[0] as string, name);
    const conversationA = (await k.admin.get(`/api/leads/${a.leadIds[0]}/conversations`)).json()[0]
      .id as number;
    expect(
      (await k.ana.post(`/api/conversations/${conversationA}/messages`, { text: 'Continuando a conversa' }))
        .statusCode,
    ).toBe(201);

    // B: Chamar sem áudio e uma mensagem mandada pelo CELULAR primeiro. Depois a atendente digita (a conversa já tinha
    // mensagem): nada disso é contato identificável.
    const b = await k.newList(1, { assignTo: k.anaId });
    const openedB = await chamar(b.leadIds[0] as number, n0(), false);
    await sentFromPhone(b.phones[0] as string, name);
    expect(
      (await k.ana.post(`/api/conversations/${openedB.json().conversationId}/messages`, { text: 'Oi' }))
        .statusCode,
    ).toBe(201);

    // C: o lead escreveu primeiro (a conversa já tinha mensagem): a resposta da atendente NÃO é primeiro contato.
    const c = await k.newList(1, { assignTo: k.anaId });
    const openedC = await chamar(c.leadIds[0] as number, n0(), false);
    await receivedFrom(c.phones[0] as string, name);
    expect(
      (
        await k.ana.post(`/api/conversations/${openedC.json().conversationId}/messages`, {
          text: 'Respondendo',
        })
      ).statusCode,
    ).toBe(201);

    // D: automação com follow-up (/run): só a etapa 1 é contato (automático); a etapa 2 não.
    const d = await k.newList(1);
    expect((await runIt(followUp, d.leadIds[0] as number, n0())).statusCode).toBe(201);
    await cycle(5);
    await cycle(30);
    expect(sentTo(d.phones[0] as string)).toHaveLength(2); // as duas etapas saíram

    // E: Chamar com áudio (CONTA, manual) com uma automação "lead chamado" que manda a etapa 1 (acompanhamento: não conta).
    const e = await k.newList(1, { assignTo: k.anaId });
    expect((await chamar(e.leadIds[0] as number, n0())).statusCode).toBe(200);
    await cycle(5);

    // F: Chamar sem áudio e a PRIMEIRA mensagem digitada (CONTA, manual).
    const f = await k.newList(1, { assignTo: k.anaId });
    const openedF = await chamar(f.leadIds[0] as number, n0(), false);
    expect(
      (
        await k.ana.post(`/api/conversations/${openedF.json().conversationId}/messages`, {
          text: 'Olá! Tudo bem?',
        })
      ).statusCode,
    ).toBe(201);

    // G: um contato manual de OUTRO dia (ontem): fica de fora do dia de hoje.
    const g = await k.newList(1, { assignTo: k.anaId });
    expect((await chamar(g.leadIds[0] as number, n0())).statusCode).toBe(200);
    const gMessage = (await messageOf(g.leadIds[0] as number))[0];
    await sql`UPDATE wa_messages SET sent_at = now() - interval '26 hours' WHERE id = ${gMessage?.id}`.execute(
      k.t.db,
    );

    // H: conversa SEM lead (contato que só escreveu) e uma mensagem do celular para um número desconhecido.
    await receivedFrom('5541999990001', name);
    await sentFromPhone('5541999990002', name);

    // Ao vivo o sistema contou A, E, F, G (manual) e D (automático); o histórico de HOJE prova A, E, F e D.
    expect(await use(n0())).toEqual({ manual: 4, automatic: 1, uncertain: 0, total: 5 });
    await wipeUsage();
    await backfill();
    expect(await use(n0())).toEqual({ manual: 3, automatic: 1, uncertain: 0, total: 4 });
    // Ontem não foi tocado (nada é recalculado fora do dia da instalação).
    const yesterday = new Date(Date.now() - 26 * 3600_000).toLocaleDateString('en-CA', {
      timeZone: 'America/Sao_Paulo',
    });
    expect(await use(n0(), yesterday)).toMatchObject({ total: 0 });
  });

  it('a etapa 1 pulada (condição) faz a 2ª ser follow-up: a mensagem dela NÃO é contato, como ao vivo', async () => {
    const automationId = await k.makeAutomation([{ text: 'Etapa 1' }, { text: 'Etapa 2', delaySeconds: 1 }]);
    // A etapa 1 só vale se o lead tiver respondido: não respondeu, então é pulada e a etapa 2 sai.
    const steps = await k.admin.get(`/api/automations/${automationId}/steps`);
    const first = steps.json()[0].id as number;
    const patched = await k.admin.patch(`/api/automations/${automationId}/steps/${first}`, {
      conditions: [{ field: 'lead_replied', operator: 'is', value: true }],
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const list = await k.newList(1);
    expect((await runIt(automationId, list.leadIds[0] as number, n0())).statusCode).toBe(201);
    await cycle(5);
    await cycle(30);
    expect(k.fake.calls.filter((c) => c.url.startsWith('/message/sendText/'))).toHaveLength(1);
    expect(await use(n0())).toMatchObject({ automatic: 0, total: 0 }); // ao vivo: nenhum contato
    await backfill();
    expect(await use(n0())).toMatchObject({ automatic: 0, total: 0 });
  });

  it('o gatilho "lead chamado" sozinho: o Chamar conta uma vez (manual) e o acompanhamento nunca conta', async () => {
    await leadCalledAutomation('Acompanhamento');
    const list = await manualContacts(2, n0());
    await cycle(5);
    expect(k.fake.calls.filter((c) => c.url.startsWith('/message/sendText/'))).toHaveLength(2);
    expect(await use(n0())).toEqual({ manual: 2, automatic: 0, uncertain: 0, total: 2 });
    await wipeUsage();
    await backfill();
    expect(await use(n0())).toEqual({ manual: 2, automatic: 0, uncertain: 0, total: 2 });
    expect(list.leadIds).toHaveLength(2);
  });

  it('lead excluído pela LGPD depois do envio some do histórico: o backfill subconta em vez de inventar', async () => {
    const list = await manualContacts(3, n0());
    const owner = await loginAs(k.t.app, await createUser(k.t.db, { name: 'Dono', role: 'dono' }));
    const r = await owner.post('/api/privacy/anonymize', {
      phone: list.phones[0],
      block: true,
      confirm: true,
    });
    expect(r.statusCode, r.body).toBe(200);
    await wipeUsage();
    await backfill();
    expect(await use(n0())).toEqual({ manual: 2, automatic: 0, uncertain: 0, total: 2 });
  });
});

// ---------- fuso de São Paulo ----------

describe('backfill: o dia é o de São Paulo', () => {
  it('23:59:59 e 00:00:00 de São Paulo caem em dias diferentes (o banco pode estar em UTC)', async () => {
    const list = await manualContacts(5, n0());
    const ids = await Promise.all(list.leadIds.map(async (id) => (await messageOf(id))[0]?.id as number));
    const instants = [
      '2026-03-10T00:00:00-03:00', // primeiro segundo de 10/03 em São Paulo
      '2026-03-10T23:59:59-03:00', // último segundo de 10/03
      '2026-03-11T00:00:00-03:00', // primeiro segundo de 11/03
      '2026-03-09T23:59:59-03:00', // último segundo de 09/03
      '2026-03-10T02:59:59Z', // = 09/03 23:59:59 em São Paulo (ainda é 09/03, embora seja dia 10 em UTC)
    ];
    for (const [i, id] of ids.entries()) {
      await sql`UPDATE wa_messages SET sent_at = ${instants[i] as string}::timestamptz WHERE id = ${id}`.execute(
        k.t.db,
      );
    }
    await wipeUsage();
    await backfill(DAY); // 10/03: os dois primeiros
    await backfill(NEXT_DAY); // 11/03: o terceiro
    await backfill('2026-03-09'); // 09/03: os dois últimos
    expect(await use(n0(), DAY)).toMatchObject({ manual: 2, total: 2 });
    expect(await use(n0(), NEXT_DAY)).toMatchObject({ manual: 1, total: 1 });
    expect(await use(n0(), '2026-03-09')).toMatchObject({ manual: 2, total: 2 });
  });
});

// ---------- repetir a migração, linha que já existe, teto ----------

describe('backfill: recalcula a linha do dia (não soma) e respeita o teto', () => {
  it('rodar de novo, duas ou três vezes, dá sempre o mesmo resultado', async () => {
    await manualContacts(4, n0());
    await autoContacts(3, n0());
    await wipeUsage();
    for (let i = 0; i < 3; i++) {
      await backfill();
      expect(await use(n0())).toEqual({ manual: 4, automatic: 3, uncertain: 0, total: 7 });
    }
    expect((await k.t.db.selectFrom('wa_instance_daily_usage').select('id').execute()).length).toBe(1);
  });

  it('linha que já existia (contatos depois da cota): fica o maior entre o gravado e o provado; o incerto é mantido', async () => {
    await manualContacts(5, n0());
    // Ao vivo: 5 manuais. Simula uma linha com mais do que o histórico prova (mensagens apagadas) e um envio incerto.
    await k.seedUsage(n0(), today(), { manual: 8, automatic: 2, uncertain: 1 });
    await backfill();
    expect(await use(n0())).toEqual({ manual: 8, automatic: 2, uncertain: 1, total: 11 });
    // Linha com MENOS do que o histórico prova (a cota só começou depois): sobe para o provado, sem somar por cima.
    await k.seedUsage(n0(), today(), { manual: 1, uncertain: 2 });
    await backfill();
    expect(await use(n0())).toEqual({ manual: 5, automatic: 0, uncertain: 2, total: 7 });
    await backfill();
    expect(await use(n0())).toEqual({ manual: 5, automatic: 0, uncertain: 2, total: 7 });
  });

  it('número que já passou de 20 no dia (antes de haver limite) fica em 20/20, o resultado conservador', async () => {
    await manualContacts(20, n0());
    await wipeUsage(); // "antes da cota": o sistema deixava passar
    await manualContacts(5, n0()); // mais 5 contatos no mesmo dia
    await wipeUsage();
    await backfill();
    const row = await use(n0());
    expect(row.total).toBe(20);
    expect(row.manual + row.automatic + row.uncertain).toBe(20);
    expect((await instanceUsage(k.t.db, [n0()], today())).get(n0())).toMatchObject({
      limitReached: true,
      remaining: 0,
    });
  });

  it('a migração (`up`) usa o dia de São Paulo de agora, não mexe em outros dias e roda sem dados', async () => {
    await backfillMigration(k.t.db); // banco sem contato nenhum: nada a fazer
    expect((await k.t.db.selectFrom('wa_instance_daily_usage').select('id').execute()).length).toBe(0);
    await manualContacts(3, n0());
    await wipeUsage();
    await k.seedUsage(n1(), '2026-01-05', { manual: 4 }); // um dia antigo já gravado: não é recalculado
    await backfillMigration(k.t.db);
    expect(await use(n0())).toEqual({ manual: 3, automatic: 0, uncertain: 0, total: 3 });
    expect(await use(n1(), '2026-01-05')).toEqual({ manual: 4, automatic: 0, uncertain: 0, total: 4 });
    const rows = await k.t.db
      .selectFrom('wa_instance_daily_usage')
      .select(['instance_id', 'usage_date'])
      .execute();
    expect(rows).toHaveLength(2);
    await expect(backfillDown(k.t.db)).resolves.toBeUndefined();
  });
});

// ---------- o limite depois do backfill ----------

describe('depois do backfill a cota continua valendo', () => {
  it('19 contatos provados → 19/20; o próximo contato passa UMA vez (20/20) e o seguinte é recusado (Chamar e /run)', async () => {
    await manualContacts(19, n0());
    await wipeUsage();
    await backfill();
    expect(await use(n0())).toEqual({ manual: 19, automatic: 0, uncertain: 0, total: 19 });

    const more = await k.newList(3, { assignTo: k.anaId });
    expect((await chamar(more.leadIds[0] as number, n0())).statusCode).toBe(200);
    expect(await use(n0())).toEqual({ manual: 20, automatic: 0, uncertain: 0, total: 20 });
    const refused = await chamar(more.leadIds[1] as number, n0());
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe(LIMIT_MESSAGE);
    const automationId = await k.makeAutomation([{ text: 'Olá' }]);
    const runRefused = await runIt(automationId, more.leadIds[2] as number, n0());
    expect(runRefused.statusCode).toBe(409);
    expect(runRefused.json().error).toBe(LIMIT_MESSAGE);
    expect(await use(n0())).toMatchObject({ total: 20 });
    // Outro número, sem contatos, continua livre.
    expect((await chamar(more.leadIds[1] as number, n1())).statusCode).toBe(200);
  });

  it('a campanha usa só a capacidade que resta de cada número: 12, 19 e 3 contatos → 8 + 1 + 17 vagas', async () => {
    await manualContacts(12, n0());
    await manualContacts(19, n1());
    await manualContacts(3, n2());
    await shiftMessagesTo(DAY);
    await wipeUsage();
    await backfill(DAY);
    expect(await use(n0(), DAY)).toMatchObject({ total: 12 });
    expect(await use(n1(), DAY)).toMatchObject({ total: 19 });
    expect(await use(n2(), DAY)).toMatchObject({ total: 3 });

    k.fake.calls.length = 0; // só interessam os envios da campanha daqui em diante
    await k.uploadAudio('Campanha');
    const automationId = await k.makeAutomation([{ audio: 'random' }]);
    const list = await k.newList(80);
    const preview = await previewCampaign(
      k.t.db,
      k.adminUser,
      automationId,
      {
        listId: list.listId,
        instanceIds: [n0(), n1(), n2()],
        windowStart: '10:00',
        windowEnd: '16:00',
        dailyLimitPerNumber: 20,
        startDate: DAY,
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      },
      at(9, 0),
    );
    expect(preview.numbers.map((n) => n.remainingToday)).toEqual([8, 1, 17]);
    expect(preview.availableToday).toBe(26);

    await k.startCampaignAt(at(9, 0), automationId, list.listId, [n0(), n1(), n2()]);
    await k.simulate({ day: DAY, from: 600, to: 965 });
    const by = k.sendsByNumber();
    // Os contatos de hoje: 12 + 19 + 3 já feitos; a campanha só preenche o que resta em cada número.
    expect(by[k.names[0]]).toBe(8);
    expect(by[k.names[1]]).toBe(1);
    expect(by[k.names[2]]).toBe(17);
    for (const id of [n0(), n1(), n2()]) expect(await use(id, DAY)).toMatchObject({ total: 20 });
  });

  it('novo dia: um número em 20/20 volta a 0/20 sozinho, sem nenhum reset manual', async () => {
    await manualContacts(20, n0());
    await shiftMessagesTo(DAY);
    await wipeUsage();
    await backfill(DAY);
    expect(await use(n0(), DAY)).toMatchObject({ total: 20 });
    expect((await instanceUsage(k.t.db, [n0()], DAY)).get(n0())).toMatchObject({ limitReached: true });
    expect((await instanceUsage(k.t.db, [n0()], NEXT_DAY)).get(n0())).toMatchObject({
      total: 0,
      remaining: 20,
      limitReached: false,
    });
    expect(await claimContactQuota(k.t.db, n0(), DAY)).toBeNull(); // dia cheio: recusa
    expect(await claimContactQuota(k.t.db, n0(), NEXT_DAY)).not.toBeNull(); // dia novo: vaga livre

    // Uma campanha em 20/20 não envia nada no dia cheio e volta a enviar no dia seguinte.
    k.fake.calls.length = 0;
    await k.uploadAudio('Campanha');
    const automationId = await k.makeAutomation([{ audio: 'random' }]);
    const list = await k.newList(30);
    await k.startCampaignAt(at(9, 0), automationId, list.listId, [n0()]);
    await k.simulate({ day: DAY, from: 600, to: 965, step: 5 });
    expect(k.sends()).toHaveLength(0);
    await k.simulate({ day: NEXT_DAY, from: 600, to: 965 });
    expect(k.sends().length).toBeGreaterThan(0);
    expect(k.sends().length).toBeLessThanOrEqual(19); // uma vaga do dia novo já foi usada acima
  });
});

// ---------- concorrência depois do backfill ----------

describe('concorrência: nunca passa de 20', () => {
  /** Uma participação de campanha já vencida (etapa 1) para o executor pegar. */
  async function dueCampaignRun(campaignId: number, automationId: number, leadId: number) {
    await k.t.db
      .insertInto('automation_runs')
      .values({
        automation_id: automationId,
        lead_id: leadId,
        instance_id: n0(),
        campaign_id: campaignId,
        slot_date: today(),
        status: 'pending',
        current_step: 1,
        started_at: new Date(Date.now() - 3_600_000),
        next_run_at: new Date(Date.now() - 60_000),
      })
      .execute();
  }

  async function contenders(o: { manual: number; runs: number; campaigns: number; workers: number }) {
    await ensureAudio();
    const manualList = await k.newList(o.manual, { assignTo: k.anaId });
    const runAutomation = await k.makeAutomation([{ text: 'Avulsa' }]);
    const runList = await k.newList(o.runs);
    for (const id of runList.leadIds) expect((await runIt(runAutomation, id, n0())).statusCode).toBe(201);
    const campaignAutomation = await k.makeAutomation([{ text: 'Campanha' }]);
    const campaignList = await k.newList(o.campaigns);
    const started = await k.startCampaign(campaignAutomation, campaignList.listId, [n0()], {
      windowStart: '00:00',
      windowEnd: '23:59',
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    for (const id of campaignList.leadIds) await dueCampaignRun(started.body.id, campaignAutomation, id);
    const dbs = Array.from({ length: o.workers }, () => createDb(createPool(k.t.url, 6)));
    const before = k.sends().length;
    try {
      const results = await Promise.all([
        ...manualList.leadIds.map((id) => chamar(id, n0())),
        ...dbs.map((db) => cycle(5, db)),
      ]);
      const manualWins = results
        .slice(0, o.manual)
        .filter((r) => (r as { statusCode: number }).statusCode === 200).length;
      const done = await k.t.db
        .selectFrom('automation_runs')
        .select('id')
        .where('status', '=', 'completed')
        .where('automation_id', 'in', [runAutomation, campaignAutomation])
        .execute();
      return { manualWins, autoWins: done.length, sent: k.sends().length - before };
    } finally {
      await Promise.all(dbs.map((db) => db.destroy()));
    }
  }

  it.each([
    [19, 1],
    [18, 2],
  ])(
    '%i/20 depois do backfill e 20 disputantes (Chamar + /run + campanha, 3 workers): só %i ganha(m) e o total é 20',
    async (start, slots) => {
      await manualContacts(start, n0());
      await wipeUsage();
      await backfill();
      expect(await use(n0())).toMatchObject({ total: start });
      const r = await contenders({ manual: 6, runs: 7, campaigns: 7, workers: 3 });
      expect(r.manualWins + r.autoWins).toBe(slots);
      expect(r.sent).toBe(slots);
      const row = await use(n0());
      expect(row.total).toBe(20);
      expect(row.uncertain).toBe(0);
      expect(row.manual + row.automatic).toBe(20);
    },
  );

  it('rodadas repetidas a partir de 19/20: sempre exatamente uma operação leva a última vaga', async () => {
    await manualContacts(19, n0());
    await wipeUsage();
    await backfill();
    for (let round = 0; round < 4; round++) {
      await k.seedUsage(n0(), today(), { manual: 19 });
      const r = await contenders({ manual: 2, runs: 2, campaigns: 2, workers: 2 });
      expect(r.manualWins + r.autoWins, `rodada ${round + 1}`).toBe(1);
      expect((await use(n0())).total, `rodada ${round + 1}`).toBe(20);
    }
  });
});
