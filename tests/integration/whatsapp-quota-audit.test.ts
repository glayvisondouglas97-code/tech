import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool } from '../../src/server/db';
import { runAutomationCycle } from '../../src/server/modules/automations/executor';
import { blockPhone } from '../../src/server/modules/blocklist/service';
import { instanceUsage, quotaDate } from '../../src/server/modules/whatsapp/quota';
import type { InstanceInfo } from '../../src/shared/conversations';
import { at, campaignKit, DAY, NEXT_DAY } from '../campaign-kit';
import { createUser, loginAs } from '../helpers';

// Auditoria final da cadeia de envio (Chamar, /run e campanha → cota → número → áudio → Evolution → mensagem), com o estado
// que o backfill deixa: reinício, resultado incerto, virada do dia e da janela, número e lead que saem no meio do caminho.

const k = campaignKit();
const today = () => quotaDate(new Date());
const n0 = () => k.numbers[0];
const n1 = () => k.numbers[1];
const chamar = (leadId: number, instanceId: number, sendAudio = true) =>
  k.ana.post(`/api/leads/${leadId}/conversation`, { instanceId, sendAudio });
const runIt = (automationId: number, leadId: number, instanceId: number) =>
  k.admin.post(`/api/automations/${automationId}/run`, { leadId, instanceId });
const use = (instance: number, day = today()) => k.usageRow(instance, day);
const cycleNow = (seconds = 5, db = k.t.db) =>
  runAutomationCycle(db, { now: new Date(Date.now() + seconds * 1000), batchSize: 50 });

let audioReady = false;
beforeEach(() => {
  audioReady = false;
});
async function ensureAudio() {
  if (!audioReady) await k.uploadAudio('Apresentação');
  audioReady = true;
}

/** Uma execução do gatilho manual (`/run`) já vencida, criada direto no banco para o relógio injetado. */
async function dueManualRun(automationId: number, leadId: number, instanceId: number, nextRunAt: Date) {
  const row = await k.t.db
    .insertInto('automation_runs')
    .values({
      automation_id: automationId,
      lead_id: leadId,
      instance_id: instanceId,
      status: 'pending',
      current_step: 1,
      started_at: new Date(nextRunAt.getTime() - 1000),
      next_run_at: nextRunAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Uma participação de campanha (etapa 1) já vencida. */
async function dueCampaignRun(
  campaignId: number,
  automationId: number,
  leadId: number,
  instanceId: number,
  nextRunAt: Date,
  slot = DAY,
) {
  const row = await k.t.db
    .insertInto('automation_runs')
    .values({
      automation_id: automationId,
      lead_id: leadId,
      instance_id: instanceId,
      campaign_id: campaignId,
      slot_date: slot,
      status: 'pending',
      current_step: 1,
      started_at: new Date(nextRunAt.getTime() - 3_600_000),
      next_run_at: nextRunAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

const runRow = (id: number) =>
  k.t.db
    .selectFrom('automation_runs')
    .select(['status', 'cancel_reason', 'instance_id', 'next_run_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

// ---------- fluxo manual (Chamar) ----------

describe('auditoria: o fluxo manual (Chamar) usa a cota do jeito certo', () => {
  it('escolhe o número certo, envia por ele, a resposta do lead e a continuação não gastam vaga', async () => {
    await ensureAudio();
    const list = await k.newList(2, { assignTo: k.anaId });
    const sent = await chamar(list.leadIds[0] as number, n1());
    expect(sent.statusCode, sent.body).toBe(200);
    expect(k.sendsByNumber()).toEqual({ [k.names[1]]: 1 }); // pelo número escolhido, e por nenhum outro
    expect(await use(n1())).toEqual({ manual: 1, automatic: 0, uncertain: 0, total: 1 });
    expect(await use(n0())).toMatchObject({ total: 0 });

    // A resposta do cliente (mensagem recebida) e a continuação da conversa não consomem vaga.
    expect((await k.reply(list.phones[0] as string, k.names[1])).statusCode).toBe(200);
    const conversation = (await k.admin.get(`/api/leads/${list.leadIds[0]}/conversations`)).json()[0]
      .id as number;
    expect(
      (await k.ana.post(`/api/conversations/${conversation}/messages`, { text: 'Continuando' })).statusCode,
    ).toBe(201);
    expect(await use(n1())).toEqual({ manual: 1, automatic: 0, uncertain: 0, total: 1 });
    // O histórico continua no mesmo número.
    const conv = await k.t.db
      .selectFrom('wa_conversations')
      .select('instance_id')
      .where('id', '=', conversation)
      .executeTakeFirstOrThrow();
    expect(conv.instance_id).toBe(n1());
  });

  it('número desconectado não recebe contato novo: nada é enviado, nenhuma vaga é gasta; reconectou, volta a funcionar', async () => {
    await ensureAudio();
    const list = await k.newList(2, { assignTo: k.anaId });
    await k.t.db.updateTable('wa_instances').set({ status: 'close' }).where('id', '=', n0()).execute();
    k.fake.closed.add(k.names[0]);
    const refused = await chamar(list.leadIds[0] as number, n0());
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(k.sends()).toHaveLength(0);
    expect(await use(n0())).toMatchObject({ total: 0 });
    k.fake.closed.delete(k.names[0]);
    expect((await chamar(list.leadIds[0] as number, n0())).statusCode).toBe(200);
    expect(await use(n0())).toMatchObject({ manual: 1, total: 1 });
  });

  it('12 contatos gravados aparecem como 12/20 na tela de Números (o que o servidor manda)', async () => {
    await k.seedUsage(n0(), today(), { manual: 7, automatic: 5 });
    const rows = (await k.admin.get('/api/instances')).json() as InstanceInfo[];
    expect(rows.find((r) => r.id === n0())?.usage).toMatchObject({
      manual: 7,
      automatic: 5,
      total: 12,
      remaining: 8,
      limitReached: false,
    });
  });
});

// ---------- reinício ----------

describe('auditoria: reinício do processo não perde nada', () => {
  it('13/20 continua 13/20 numa conexão nova e a participação pendente segue no banco e é enviada por ela', async () => {
    await k.seedUsage(n0(), today(), { manual: 9, automatic: 4 });
    const automationId = await k.makeAutomation([{ text: 'Olá!' }]);
    const list = await k.newList(1);
    const created = await runIt(automationId, list.leadIds[0] as number, n0());
    expect(created.statusCode, created.body).toBe(201);
    expect(await use(n0())).toMatchObject({ total: 13 });

    // "Reiniciou": conexão nova, nenhum estado em memória do processo anterior.
    const fresh = createDb(createPool(k.t.url, 4));
    try {
      expect((await instanceUsage(fresh, [n0()], today())).get(n0())).toMatchObject({
        manual: 9,
        automatic: 4,
        total: 13,
        remaining: 7,
      });
      const pending = await fresh
        .selectFrom('automation_runs')
        .select(['status', 'current_step'])
        .where('id', '=', created.json().id)
        .executeTakeFirst();
      expect(pending).toEqual({ status: 'pending', current_step: 1 });
      expect((await cycleNow(5, fresh)).sent).toBe(1);
    } finally {
      await fresh.destroy();
    }
    expect(await use(n0())).toEqual({ manual: 9, automatic: 5, uncertain: 0, total: 14 });
  });
});

// ---------- resultado incerto ----------

describe('auditoria: resultado incerto nunca é reenviado às cegas', () => {
  it('erro 5xx no /run: a vaga fica ocupada, a execução falha com o motivo e nada é repetido em ciclos seguintes', async () => {
    await k.seedUsage(n0(), today(), { manual: 12 });
    const automationId = await k.makeAutomation([{ text: 'Olá!' }]);
    const list = await k.newList(1);
    const created = await runIt(automationId, list.leadIds[0] as number, n0());
    expect(created.statusCode, created.body).toBe(201);
    const runId = created.json().id as number;
    k.fake.failSends = { status: 500, message: 'erro interno da Evolution' };
    await cycleNow(5);
    k.fake.failSends = null;

    expect(await runRow(runId)).toMatchObject({
      status: 'failed',
      cancel_reason: 'resultado_incerto',
      instance_id: n0(),
    });
    // A vaga continua ocupada (como incerta): 12 manuais + 1 incerta. Nunca se devolve uma vaga que pode ter sido gasta.
    expect(await use(n0())).toEqual({ manual: 12, automatic: 0, uncertain: 1, total: 13 });
    const stepRun = await k.t.db
      .selectFrom('automation_step_runs')
      .select(['status', 'attempts', 'error', 'message_id'])
      .where('automation_run_id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(stepRun).toMatchObject({ status: 'failed', attempts: 1, message_id: null });
    expect(stepRun.error).toMatch(/Não foi reenviada/); // o histórico mostra o problema
    // Ciclos seguintes (agora a Evolution até funciona): não há reenvio, nem laço de tentativas.
    for (const seconds of [10, 400, 4000]) await cycleNow(seconds);
    expect(k.fake.calls.filter((c) => c.url.startsWith('/message/send'))).toHaveLength(1);
    expect(await use(n0())).toMatchObject({ uncertain: 1, total: 13 });
  });

  it('recusa clara (4xx) devolve a vaga e a execução falha com o motivo, sem repetir', async () => {
    const automationId = await k.makeAutomation([{ text: 'Olá!' }]);
    const list = await k.newList(1);
    const created = await runIt(automationId, list.leadIds[0] as number, n0());
    k.fake.failSends = { status: 400, message: 'recusado' };
    await cycleNow(5);
    k.fake.failSends = null;
    expect(await runRow(created.json().id)).toMatchObject({
      status: 'failed',
      cancel_reason: 'envio_recusado',
    });
    expect(await use(n0())).toEqual({ manual: 0, automatic: 0, uncertain: 0, total: 0 }); // a vaga voltou
  });
});

// ---------- virada do dia e da janela ----------

describe('auditoria: virada do dia e da janela em America/Sao_Paulo', () => {
  it('a data da cota muda exatamente à meia-noite de São Paulo (03:00 UTC), não à meia-noite UTC', () => {
    expect(quotaDate(new Date('2026-03-11T02:59:59Z'))).toBe('2026-03-10'); // 23:59:59 em São Paulo
    expect(quotaDate(new Date('2026-03-11T03:00:00Z'))).toBe('2026-03-11'); // 00:00:00 em São Paulo
    expect(quotaDate(new Date('2026-03-10T23:59:59Z'))).toBe('2026-03-10'); // 20:59:59 em São Paulo
    expect(quotaDate(new Date('2026-03-10T00:00:00Z'))).toBe('2026-03-09'); // 21:00 do dia anterior em SP
  });

  it('/run às 23:59:59 gasta a vaga do dia; às 00:00:00 gasta a do dia seguinte (a cota do dia anterior não muda)', async () => {
    const automationId = await k.makeAutomation([{ text: 'Olá!' }]);
    const list = await k.newList(2);
    await dueManualRun(automationId, list.leadIds[0] as number, n0(), at(23, 59, 0));
    await dueManualRun(automationId, list.leadIds[1] as number, n0(), at(23, 59, 50));
    expect((await runAutomationCycle(k.t.db, { now: at(23, 59, 40) })).sent).toBe(1); // só o primeiro venceu
    expect(await use(n0(), DAY)).toEqual({ manual: 0, automatic: 1, uncertain: 0, total: 1 });
    expect((await runAutomationCycle(k.t.db, { now: at(0, 0, 0, NEXT_DAY) })).sent).toBe(1);
    expect(await use(n0(), DAY)).toMatchObject({ automatic: 1, total: 1 });
    expect(await use(n0(), NEXT_DAY)).toEqual({ manual: 0, automatic: 1, uncertain: 0, total: 1 });
  });

  it('campanha 10:00–16:00: 15:59:59 envia e gasta a vaga do dia; 16:00:00 não envia e o envio vai para o dia seguinte', async () => {
    await k.uploadAudio('Campanha');
    const automationId = await k.makeAutomation([{ audio: 'random' }]);
    const list = await k.newList(2);
    const campaign = await k.startCampaignAt(at(9, 0), automationId, list.listId, [n0()]);
    const first = await dueCampaignRun(
      campaign.id,
      automationId,
      list.leadIds[0] as number,
      n0(),
      at(15, 59, 0),
    );
    const second = await dueCampaignRun(
      campaign.id,
      automationId,
      list.leadIds[1] as number,
      n0(),
      at(16, 0, 0),
    );

    expect((await runAutomationCycle(k.t.db, { now: at(15, 59, 59) })).sent).toBe(1);
    expect((await runRow(first)).status).toBe('completed');
    expect(await use(n0(), DAY)).toMatchObject({ automatic: 1, total: 1 });
    // 16:00:00: a janela fechou. Nada é pego, nada é gasto.
    expect((await runAutomationCycle(k.t.db, { now: at(16, 0, 0) })).claimed).toBe(0);
    expect((await runRow(second)).status).toBe('pending');
    expect(await use(n0(), DAY)).toMatchObject({ total: 1 });
    // No dia seguinte, na abertura da janela (10:00), ele sai e gasta a vaga do dia SEGUINTE.
    expect((await runAutomationCycle(k.t.db, { now: at(9, 59, 59, NEXT_DAY) })).claimed).toBe(0);
    expect((await runAutomationCycle(k.t.db, { now: at(10, 0, 0, NEXT_DAY) })).sent).toBe(1);
    expect(await use(n0(), DAY)).toMatchObject({ total: 1 });
    expect(await use(n0(), NEXT_DAY)).toMatchObject({ automatic: 1, total: 1 });
  });
});

// ---------- número, bloqueio e LGPD ----------

describe('auditoria: número e lead que saem no meio do caminho não gastam vaga', () => {
  it('número excluído: a participação é cancelada (sem número), nada é enviado e a cota dele some junto', async () => {
    const automationId = await k.makeAutomation([{ text: 'Olá!' }]);
    const list = await k.newList(1);
    const created = await runIt(automationId, list.leadIds[0] as number, n1());
    await k.seedUsage(n1(), today(), { manual: 5 });
    const removed = await k.admin.post(`/api/instances/${n1()}/delete`, { confirm: 'EXCLUIR' });
    expect(removed.statusCode, removed.body).toBe(200);
    await cycleNow(5);
    expect(k.sends()).toHaveLength(0);
    expect((await runRow(created.json().id)).status).toBe('cancelled');
    expect(
      (
        await k.t.db
          .selectFrom('wa_instance_daily_usage')
          .select('id')
          .where('instance_id', '=', n1())
          .execute()
      ).length,
    ).toBe(0);
    // Reconecta o número para os outros testes do arquivo (o kit o recria a cada arquivo, não a cada teste).
  });

  it('telefone que entra em "não contatar" cancela a participação pendente sem gastar a vaga', async () => {
    const automationId = await k.makeAutomation([{ text: 'Olá!' }]);
    const list = await k.newList(1);
    const created = await runIt(automationId, list.leadIds[0] as number, n0());
    expect(await blockPhone(k.t.db, null, list.phones[0] as string, 'pediu para não receber')).toBe(1);
    await cycleNow(5);
    expect(k.sends()).toHaveLength(0);
    expect(await runRow(created.json().id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'lead_bloqueado',
    });
    expect(await use(n0())).toMatchObject({ total: 0 });
    // Chamar o lead bloqueado também não passa (e nada é gasto).
    const refused = await chamar(list.leadIds[0] as number, n0());
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(await use(n0())).toMatchObject({ total: 0 });
  });

  it('LGPD: anonimizar o titular cancela a participação pendente, não envia nada e não mexe na cota do dia', async () => {
    await ensureAudio();
    const chamados = await k.newList(1, { assignTo: k.anaId });
    expect((await chamar(chamados.leadIds[0] as number, n0())).statusCode).toBe(200);
    const automationId = await k.makeAutomation([{ text: 'Olá!' }]);
    const list = await k.newList(1);
    const created = await runIt(automationId, list.leadIds[0] as number, n0());
    const owner = await loginAs(k.t.app, await createUser(k.t.db, { name: 'Dono', role: 'dono' }));
    for (const phone of [list.phones[0], chamados.phones[0]]) {
      const r = await owner.post('/api/privacy/anonymize', { phone, block: true, confirm: true });
      expect(r.statusCode, r.body).toBe(200);
    }
    const sendsBefore = k.sends().length;
    await cycleNow(5);
    expect(k.sends()).toHaveLength(sendsBefore); // nada novo saiu
    expect((await runRow(created.json().id)).status).toBe('cancelled');
    // O contato do Chamar aconteceu: a cota do dia continua contando (a mensagem apagada não "devolve" a vaga).
    expect(await use(n0())).toEqual({ manual: 1, automatic: 0, uncertain: 0, total: 1 });
  });
});
