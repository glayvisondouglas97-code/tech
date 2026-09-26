import { describe, expect, it } from 'vitest';
import {
  AUTO_CAMPAIGN_KEY,
  activateAutoCampaign,
  autoCampaignState,
  pauseAutoCampaign,
} from '../../src/server/modules/automations/auto-campaign';
import { runAutomationCycle } from '../../src/server/modules/automations/executor';
import { addDays, spTime } from '../../src/server/modules/automations/window';
import { at, campaignKit, DAY, NEXT_DAY } from '../campaign-kit';

// Campanha automática (pré-definida pelo sistema): o gestor só ativa ou pausa. Mesmo banco de testes e Evolution de
// mentira das outras campanhas; o relógio é injetado (DAY é uma terça-feira).

const k = campaignKit();

const destination = (call: { body: unknown }) =>
  String((call.body as { number: string }).number).split('@')[0] as string;
const instanceOf = (call: { url: string }) => call.url.split('/').pop() ?? '';
const audioOf = (call: { body: unknown }) => (call.body as { audio: string }).audio;

const activate = (now = at(9, 0)) => activateAutoCampaign(k.t.db, k.adminUser, null, now);
const pause = (now = at(9, 0)) => pauseAutoCampaign(k.t.db, k.adminUser, null, now);
const state = (now: Date) => autoCampaignState(k.t.db, now);

async function systemCampaigns() {
  return k.t.db
    .selectFrom('automation_campaigns as c')
    .innerJoin('automations as a', 'a.id', 'c.automation_id')
    .selectAll('c')
    .where('a.system_key', '=', AUTO_CAMPAIGN_KEY)
    .orderBy('c.id')
    .execute();
}

describe('campanha automática: ativar', () => {
  it('sem áudio no sorteio, ativar é recusado com uma mensagem clara', async () => {
    await expect(activate()).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/áudio/),
    });
    expect(await systemCampaigns()).toHaveLength(0);
  });

  it('cria a campanha pré-definida (todas as listas, todos os números, seg–sex 10:00–16:00, 20/dia) e é idempotente', async () => {
    await k.uploadAudio('A1');
    const first = await activate(at(9, 0));
    expect(first).toMatchObject({
      status: 'active',
      phase: 'before_window',
      headline: 'Ativa · começa hoje às 10:00',
    });
    expect(first.rules).toEqual({
      windowStart: '10:00',
      windowEnd: '16:00',
      days: 'Seg–Sex',
      dailyLimitPerNumber: 20,
    });

    const automation = await k.t.db
      .selectFrom('automations')
      .selectAll()
      .where('system_key', '=', AUTO_CAMPAIGN_KEY)
      .executeTakeFirstOrThrow();
    expect(automation).toMatchObject({ status: 'active', trigger_type: 'manual' });
    const steps = await k.t.db
      .selectFrom('automation_steps')
      .selectAll()
      .where('automation_id', '=', automation.id)
      .execute();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      position: 1,
      action_type: 'send_audio',
      audio_mode: 'random',
      delay_seconds: 0,
    });

    const [campaign] = await systemCampaigns();
    expect(campaign).toMatchObject({
      status: 'active',
      all_lists: true,
      all_numbers: true,
      list_id: null,
      instance_ids: [],
      window_start_min: 600,
      window_end_min: 960,
      days_of_week: [1, 2, 3, 4, 5],
      daily_limit: 20,
    });

    // Clicar de novo não cria outra campanha nem muda nada.
    await activate(at(9, 5));
    expect(await systemCampaigns()).toHaveLength(1);
  });

  it('a automação do sistema não aparece nem muda pela API genérica', async () => {
    await k.uploadAudio('A1');
    await activate();
    const [campaign] = await systemCampaigns();
    const id = campaign?.automation_id as number;
    const list = await k.admin.get('/api/automations');
    expect((list.json() as { id: number }[]).map((a) => a.id)).not.toContain(id);
    expect((await k.admin.patch(`/api/automations/${id}`, { name: 'Outra' })).statusCode).toBe(409);
    expect((await k.admin.patch(`/api/automations/${id}/status`, { status: 'paused' })).statusCode).toBe(409);
    expect((await k.admin.post(`/api/automations/${id}/archive`, {})).statusCode).toBe(409);
    expect(
      (
        await k.admin.post(`/api/automations/${id}/steps`, {
          actionType: 'send_text',
          delaySeconds: 0,
          messageText: 'Oi',
          conditions: [],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await k.admin.post(`/api/automations/${id}/campaigns/${campaign?.id}/pause`, {})).statusCode,
    ).toBe(409);
    expect((await k.admin.post(`/api/automations/${id}/campaigns/${campaign?.id}/stop`, {})).statusCode).toBe(
      409,
    );
  });

  it('rotas: dono/admin veem e comandam; atendente não', async () => {
    await k.uploadAudio('A1');
    expect((await k.ana.get('/api/auto-campaign')).statusCode).toBe(403);
    expect((await k.ana.post('/api/auto-campaign/activate', {})).statusCode).toBe(403);
    const off = await k.admin.get('/api/auto-campaign');
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ status: 'off', headline: 'Desativada' });
    const on = await k.admin.post('/api/auto-campaign/activate', {});
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().status).toBe('active');
    const paused = await k.admin.post('/api/auto-campaign/pause', {});
    expect(paused.json()).toMatchObject({ status: 'paused', headline: 'Pausada' });
  });
});

describe('campanha automática: envio', () => {
  it('só envia de segunda a sexta, das 10:00 às 16:00, para leads de TODAS as listas, por todos os números', async () => {
    const audios = [await k.uploadAudio('A1'), await k.uploadAudio('A2'), await k.uploadAudio('A3')];
    const a = await k.newList(5, { name: 'Lista A' });
    const b = await k.newList(4, { name: 'Lista B' });
    await activate(at(8, 0));

    // Antes das 10:00: nada sai.
    await k.simulate({ from: 480, to: 599 });
    expect(k.sends()).toHaveLength(0);

    await k.simulate({ from: 600, to: 965 });
    const sends = k.sends();
    expect(sends).toHaveLength(9);
    expect(new Set(sends.map(destination))).toEqual(new Set([...a.phones, ...b.phones]));
    // Todos os números entram no rodízio, e todos os áudios saem (rodízio: nenhum repete antes de todos saírem).
    expect(new Set(sends.map(instanceOf))).toEqual(new Set(k.names));
    const used = sends.map(audioOf);
    expect(new Set(used.slice(0, 3))).toEqual(new Set(audios.map((x) => x.bytes.toString('base64'))));
    // Cada lead passou a "Chamado · Mensagem enviada", sem atendente.
    const leads = await k.t.db
      .selectFrom('leads')
      .select(['status', 'result', 'assigned_to'])
      .where('id', 'in', [...a.leadIds, ...b.leadIds])
      .execute();
    expect(
      leads.every((l) => l.status === 'chamado' && l.result === 'enviado' && l.assigned_to === null),
    ).toBe(true);
  });

  it('sábado e domingo não envia; segunda volta às 10:00', async () => {
    await k.uploadAudio('A1');
    const saturday = '2026-03-14';
    const monday = '2026-03-16';
    await activate(at(9, 0));
    const list = await k.newList(2);
    expect((await state(at(11, 0, 0, saturday))).headline).toBe('Ativa · volta na segunda às 10:00');
    await k.simulate({ day: saturday, from: 600, to: 965, step: 5 });
    await k.simulate({ day: '2026-03-15', from: 600, to: 965, step: 5 });
    expect(k.sends()).toHaveLength(0);
    await k.simulate({ day: monday, from: 590, to: 700 });
    expect(k.sends().map(destination).sort()).toEqual([...list.phones].sort());
  });

  it('cota: no máximo 20 contatos novos por número por dia (somando os manuais); o resto vai para o dia seguinte', async () => {
    await k.uploadAudio('A1');
    // Só um número conectado, que já fez 5 contatos manuais hoje: sobram 15 vagas.
    await k.t.db
      .updateTable('wa_instances')
      .set({ status: 'close' })
      .where('id', '<>', k.numbers[0])
      .execute();
    await k.seedUsage(k.numbers[0], DAY, { manual: 5 });
    await k.newList(25);
    await activate(at(9, 0));
    expect((await state(at(9, 30))).metrics).toMatchObject({
      toSendToday: 15,
      available: 25,
      capacityToday: 15,
    });
    await k.simulate({ from: 600, to: 965 });
    expect(k.sends()).toHaveLength(15);
    expect(await k.usageRow(k.numbers[0], DAY)).toEqual({
      manual: 5,
      automatic: 15,
      uncertain: 0,
      total: 20,
    });
    await k.simulate({ day: NEXT_DAY, from: 600, to: 965 });
    expect(k.sends()).toHaveLength(25);
    expect((await k.usageRow(k.numbers[0], NEXT_DAY)).automatic).toBe(10);
  });

  it('pausar para de enviar; ativar de novo retoma sem repetir nenhum lead', async () => {
    await k.uploadAudio('A1');
    await k.newList(6);
    await activate(at(9, 0));
    await k.simulate({ from: 600, to: 605 });
    const before = k.sends().length;
    expect(before).toBeGreaterThan(0);
    await pause(at(10, 6));
    await k.simulate({ from: 606, to: 800 });
    expect(k.sends()).toHaveLength(before);
    expect((await state(at(13, 0))).status).toBe('paused');
    await activate(at(13, 21));
    await k.simulate({ from: 801, to: 965 });
    const destinations = k.sends().map(destination);
    expect(destinations).toHaveLength(6);
    expect(new Set(destinations).size).toBe(6);
  });

  it('não termina quando a fila esvazia: lead importado depois também recebe', async () => {
    await k.uploadAudio('A1');
    await k.newList(2);
    await activate(at(9, 0));
    await k.simulate({ from: 600, to: 965 });
    expect(k.sends()).toHaveLength(2);
    expect((await systemCampaigns())[0]?.status).toBe('active');
    const late = await k.newList(1);
    await k.simulate({ day: NEXT_DAY, from: 600, to: 700 });
    expect(k.sends().map(destination)).toContain(late.phones[0]);
  });

  it('sem áudio no sorteio, nenhum lead é reservado (ninguém sai da fila sem receber)', async () => {
    const audio = await k.uploadAudio('A1');
    const list = await k.newList(3);
    await activate(at(9, 0));
    await k.admin.patch(`/api/audios/${audio.id}`, { active: false });
    await k.simulate({ from: 600, to: 700 });
    expect(k.sends()).toHaveLength(0);
    const [campaign] = await systemCampaigns();
    expect(await k.campaignRuns(campaign?.id as number)).toHaveLength(0);
    expect((await state(at(11, 41))).warnings.join(' ')).toMatch(/Nenhum áudio no sorteio/);
    await k.admin.patch(`/api/audios/${audio.id}`, { active: true });
    await k.simulate({ from: 701, to: 800 });
    expect(k.sends().map(destination).sort()).toEqual([...list.phones].sort());
  });
});

describe('campanha automática: métricas', () => {
  it('para enviar hoje, enviados, sem WhatsApp, responderam e não responderam (hoje e no total)', async () => {
    await k.uploadAudio('A1');
    const list = await k.newList(4);
    // Um dos telefones não tem WhatsApp (a Evolution de mentira responde "não existe" para final 9999).
    const noWa = `${(list.phones[3] as string).slice(0, -4)}9999`;
    await k.t.db
      .updateTable('leads')
      .set({ phone: noWa })
      .where('id', '=', list.leadIds[3] as number)
      .execute();

    const off = await state(at(9, 0));
    expect(off.metrics).toMatchObject({ toSendToday: 0, available: 4, capacityToday: 60 });

    await activate(at(9, 0));
    expect((await state(at(9, 1))).metrics.toSendToday).toBe(4);

    await k.simulate({ from: 600, to: 965 });
    const sends = k.sends();
    expect(sends).toHaveLength(3);
    // Um dos leads responde.
    const replied = sends[0] as (typeof sends)[number];
    await k.reply(destination(replied), instanceOf(replied));

    const s = await state(at(16, 30));
    expect(s.phase).toBe('after_window');
    expect(s.headline).toBe('Ativa · volta amanhã às 10:00');
    expect(s.metrics.today).toEqual({ sent: 3, noWhatsapp: 1, replied: 1, notReplied: 2 });
    expect(s.metrics.total).toEqual({ sent: 3, noWhatsapp: 1, replied: 1, notReplied: 2 });
    expect(s.metrics).toMatchObject({ toSendToday: 0, available: 0, capacityToday: 0 });
    expect(s.numbers).toHaveLength(3);
    expect(s.numbers.reduce((sum, n) => sum + n.automaticToday, 0)).toBe(3);

    // No dia seguinte, "hoje" zera e o total continua.
    const tomorrow = await state(at(9, 0, 0, NEXT_DAY));
    expect(tomorrow.metrics.today).toEqual({ sent: 0, noWhatsapp: 0, replied: 0, notReplied: 0 });
    expect(tomorrow.metrics.total.sent).toBe(3);
  });
});

describe('correções da revisão', () => {
  it('campanha com o filtro "Já chamado" envia de verdade para os leads chamados e livres', async () => {
    await k.uploadAudio('A1');
    const automationId = await k.makeAutomation([{ audio: 'random' }]);
    const list = await k.newList(3);
    await k.t.db
      .updateTable('leads')
      .set({ status: 'chamado', called_at: new Date(), result: 'nao_respondeu' })
      .where('id', 'in', list.leadIds)
      .execute();
    const started = await k.startCampaign(automationId, list.listId, [k.numbers[0]], {
      filters: { status: ['chamado'] },
    });
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    await k.simulate({ from: 600, to: 700 });
    expect(k.sends().map(destination).sort()).toEqual([...list.phones].sort());
    const runs = await k.campaignRuns(started.body.id);
    expect(runs.every((r) => r.status === 'completed')).toBe(true);
  });

  it('execução manual sem cota espera o próximo dia útil às 10:00, nunca a meia-noite', async () => {
    const automationId = await k.makeAutomation([{ text: 'Oi, {{nome}}!' }]);
    const list = await k.newList(1);
    const r = await k.admin.post(`/api/automations/${automationId}/run`, {
      leadId: list.leadIds[0],
      instanceId: k.numbers[0],
    });
    expect(r.statusCode, r.body).toBe(201);
    // A participação vence numa sexta às 14:59 e, entre criar e enviar, o número encheu: a próxima tentativa é segunda
    // às 10:00 (antes esperava a meia-noite e o contato saía às 00:00).
    const friday = '2026-03-13';
    await k.t.db
      .updateTable('automation_runs')
      .set({ started_at: at(14, 58, 0, friday), next_run_at: at(14, 59, 0, friday) })
      .where('id', '=', r.json().id)
      .execute();
    await k.seedUsage(k.numbers[0], friday, { manual: 20 });
    await runAutomationCycle(k.t.db, { now: at(15, 0, 0, friday) });
    const run = await k.t.db
      .selectFrom('automation_runs')
      .select(['status', 'next_run_at'])
      .where('id', '=', r.json().id)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('pending');
    const next = spTime(run.next_run_at as Date);
    expect(next).toMatchObject({ date: addDays(friday, 3), minutes: 600 });
    expect(k.sends()).toHaveLength(0);
  });

  it('dois envios ao mesmo tempo na mesma conversa nova de um lead gastam UMA vaga da cota', async () => {
    const list = await k.newList(1, { assignTo: k.anaId });
    const opened = await k.ana.post(`/api/leads/${list.leadIds[0]}/conversation`, {
      instanceId: k.numbers[0],
      sendAudio: false,
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const conversationId = opened.json().conversationId as number;
    const [a, b] = await Promise.all([
      k.ana.post(`/api/conversations/${conversationId}/messages`, { text: 'Olá!' }),
      k.ana.post(`/api/conversations/${conversationId}/messages`, { text: 'Tudo bem?' }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    const today = spTime(new Date()).date;
    expect(await k.usageRow(k.numbers[0], today)).toMatchObject({ manual: 1, total: 1 });
  });
});

describe('campanha automática: número novo', () => {
  it('número cadastrado depois de ativar entra sozinho no rodízio', async () => {
    await k.uploadAudio('A1');
    await activate(at(9, 0));
    await k.hook('connection.update', { state: 'open', wuid: '5511900000009@s.whatsapp.net' }, 'whatsapp-04');
    await k.t.db.updateTable('wa_instances').set({ status: 'close' }).where('name', 'in', k.names).execute();
    const list = await k.newList(2);
    await k.simulate({ day: addDays(DAY, 1), from: 600, to: 700 });
    expect(k.sends().map(instanceOf)).toEqual(['whatsapp-04', 'whatsapp-04']);
    expect(k.sends().map(destination).sort()).toEqual([...list.phones].sort());
  });
});
