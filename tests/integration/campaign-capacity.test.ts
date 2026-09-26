import { describe, expect, it } from 'vitest';
import {
  campaignCalendar,
  campaignStats,
  previewCampaign,
} from '../../src/server/modules/automations/campaigns';
import type { CampaignInput, CampaignPreview } from '../../src/shared/api';
import { at, campaignKit, DAY } from '../campaign-kit';

// Prévia, capacidade real (cota unificada), estimativa aproximada, calendário e contadores do painel. Tudo vem do servidor,
// com o relógio injetado: terça 10/03/2026, 09:00 em São Paulo (a janela abre às 10:00). Quarta 11 · Sexta 13 · Sáb 14 · Seg 16.

const k = campaignKit();
const NOW = at(9, 0);
const TODAY = DAY;

interface Setup {
  automationId: number;
  listId: string;
  leadIds: number[];
  phones: string[];
}

async function setup(leads: number): Promise<Setup> {
  const automationId = await k.makeAutomation([{ text: 'Olá!' }]);
  const list = await k.newList(leads);
  return { automationId, listId: list.listId, leadIds: list.leadIds, phones: list.phones };
}

const input = (s: Setup, ids: number[], extra: Partial<CampaignInput> = {}): CampaignInput => ({
  listId: s.listId,
  instanceIds: ids,
  windowStart: '10:00',
  windowEnd: '16:00',
  dailyLimitPerNumber: 20,
  startDate: TODAY,
  daysOfWeek: [1, 2, 3, 4, 5],
  ...extra,
});

const preview = (
  s: Setup,
  ids: number[],
  extra: Partial<CampaignInput> = {},
  now = NOW,
): Promise<CampaignPreview> =>
  previewCampaign(k.t.db, k.adminUser, s.automationId, input(s, ids, extra), now);

const setStatus = (id: number, status: 'open' | 'close') =>
  k.t.db.updateTable('wa_instances').set({ status }).where('id', '=', id).execute();

describe('capacidade real pela cota unificada', () => {
  it('1, 2 e 3 números conectados: 20, 40 e 60 contatos por dia (e hoje, com o dia vazio, cabe o mesmo)', async () => {
    const s = await setup(200);
    const [n1, n2, n3] = k.numbers;
    for (const [ids, expected] of [
      [[n1], 20],
      [[n1, n2], 40],
      [[n1, n2, n3], 60],
    ] as const) {
      const p = await preview(s, [...ids]);
      expect(p.dailyCapacity, `${ids.length} número(s)`).toBe(expected);
      expect(p.availableToday).toBe(expected);
      expect(p.connectedNumbers).toBe(ids.length);
      expect(p.estimate).toMatchObject({
        capacityPerDay: expected,
        capacityToday: expected,
        connectedNumbers: ids.length,
      });
    }
  });

  it('desconta contatos MANUAIS e AUTOMÁTICOS já feitos hoje (a cota é uma só)', async () => {
    const s = await setup(200);
    const [n1, n2, n3] = k.numbers;
    await k.seedUsage(n1, TODAY, { manual: 6, automatic: 8 }); // 14/20
    await k.seedUsage(n2, TODAY, { automatic: 7 }); // 7/20
    await k.seedUsage(n3, TODAY, { manual: 20 }); // 20/20: cheio
    const p = await preview(s, [n1, n2, n3]);
    const byId = new Map(p.numbers.map((n) => [n.id, n]));
    expect(byId.get(n1)).toMatchObject({
      manualToday: 6,
      automaticToday: 8,
      usedToday: 14,
      remainingToday: 6,
      limitReached: false,
    });
    expect(byId.get(n2)).toMatchObject({ usedToday: 7, remainingToday: 13 });
    expect(byId.get(n3)).toMatchObject({ usedToday: 20, remainingToday: 0, limitReached: true });
    expect(p.availableToday).toBe(6 + 13 + 0); // o número cheio não entra na conta de hoje
    expect(p.estimate.capacityToday).toBe(19);
    expect(p.dailyCapacity).toBe(60); // amanhã o dia começa vazio de novo
    expect(p.estimate.capacityPerDay).toBe(60);
  });

  it('o envio incerto (em andamento) também ocupa vaga, e o limite da campanha (10) vale antes do teto de 20', async () => {
    const s = await setup(100);
    const [n1, n2] = k.numbers;
    await k.seedUsage(n1, TODAY, { manual: 2, automatic: 2, uncertain: 1 });
    const p = await preview(s, [n1, n2], { dailyLimitPerNumber: 10 });
    expect(p.numbers[0]).toMatchObject({
      dailyLimit: 10,
      usedToday: 5,
      remainingToday: 5,
      uncertainToday: 1,
    });
    expect(p.numbers[1]).toMatchObject({ dailyLimit: 10, usedToday: 0, remainingToday: 10 });
    expect(p.availableToday).toBe(15);
    expect(p.dailyCapacity).toBe(20);
  });

  it('número desconectado não conta (nem hoje nem por dia) e volta a contar quando reconecta', async () => {
    const s = await setup(100);
    const [n1, n2, n3] = k.numbers;
    await setStatus(n2, 'close');
    const down = await preview(s, [n1, n2, n3]);
    expect(down).toMatchObject({ connectedNumbers: 2, dailyCapacity: 40, availableToday: 40 });
    expect(down.numbers.find((n) => n.id === n2)).toMatchObject({ connected: false, status: 'close' });
    await setStatus(n2, 'open');
    expect(await preview(s, [n1, n2, n3])).toMatchObject({
      connectedNumbers: 3,
      dailyCapacity: 60,
      availableToday: 60,
    });
  });

  it('nunca usa o limite de pegar leads: a capacidade é a cota do número (20), mesmo com outro valor configurado', async () => {
    const s = await setup(100);
    // O limite de "pegar leads" (por usuário e do sistema) é outra coisa e não entra na conta da campanha.
    await k.t.db.updateTable('users').set({ daily_pull_limit: 500 }).execute();
    await k.t.db.updateTable('settings').set({ daily_pull_limit: 500 }).execute();
    const p = await preview(s, [k.numbers[0]], { dailyLimitPerNumber: 20 });
    expect(p.dailyCapacity).toBe(20);
    expect(p.numbers[0]?.dailyLimit).toBe(20);
  });

  it('a capacidade de hoje é zero depois que a janela fecha e em dia que a campanha não executa', async () => {
    const s = await setup(100);
    const late = await preview(s, [k.numbers[0]], {}, at(17, 0));
    expect(late.estimate.capacityToday).toBe(0);
    expect(late.calendar[0]).toMatchObject({ date: TODAY, state: 'window_closed', capacity: 0 });
    const saturday = await preview(
      s,
      [k.numbers[0]],
      { startDate: '2026-03-14' },
      at(11, 0, 0, '2026-03-14'),
    );
    expect(saturday.estimate.capacityToday).toBe(0);
    expect(saturday.calendar[0]).toMatchObject({
      date: '2026-03-14',
      weekday: 6,
      state: 'not_allowed',
      capacity: 0,
    });
  });
});

describe('estimativa aproximada', () => {
  it('leva em conta a cota que sobrou hoje e só os dias em que a campanha executa', async () => {
    const s = await setup(130);
    // 3 números, 60/dia. Quinta 12/03: hoje cabe 60, sexta 60, sobram 10 para segunda 16/03 (sábado e domingo não executam).
    const p = await preview(s, k.numbers, { startDate: '2026-03-12' }, at(9, 0, 0, '2026-03-12'));
    expect(p.estimate).toMatchObject({
      status: 'ok',
      eligible: 130,
      runDays: 3,
      firstDay: '2026-03-12',
      lastDay: '2026-03-16',
      leftover: 0,
    });
  });

  it('com a cota de hoje já usada, o primeiro dia rende menos', async () => {
    const s = await setup(100);
    for (const id of k.numbers) await k.seedUsage(id, TODAY, { manual: 10 }); // sobram 10 em cada: 30 hoje
    const p = await preview(s, k.numbers);
    // 100 leads: terça 30, quarta 60 (=90), quinta os 10 que faltam => três dias.
    expect(p.estimate).toMatchObject({
      status: 'ok',
      capacityToday: 30,
      runDays: 3,
      firstDay: TODAY,
      lastDay: '2026-03-12',
    });
  });

  it('passou da data final: diz quantos ficariam de fora; sem número conectado: sem capacidade', async () => {
    const s = await setup(200);
    const short = await preview(s, k.numbers, { endDate: '2026-03-11' });
    expect(short.estimate).toMatchObject({
      status: 'beyond_end_date',
      runDays: 2,
      leftover: 80,
      lastDay: '2026-03-11',
    });
    for (const id of k.numbers) await setStatus(id, 'close');
    const none = await preview(s, k.numbers);
    expect(none.estimate).toMatchObject({ status: 'no_capacity', connectedNumbers: 0 });
    for (const id of k.numbers) await setStatus(id, 'open');
    const s2 = await setup(0);
    expect((await preview(s2, k.numbers)).estimate.status).toBe('no_audience');
  });

  it('é aproximada: a interface recebe o status e os números, nunca uma data prometida', async () => {
    const s = await setup(30);
    const p = await preview(s, [k.numbers[0]]);
    expect(Object.keys(p.estimate).sort()).toEqual(
      [
        'capacityPerDay',
        'capacityToday',
        'connectedNumbers',
        'eligible',
        'firstDay',
        'lastDay',
        'leftover',
        'runDays',
        'status',
      ].sort(),
    );
  });
});

describe('calendário de capacidade', () => {
  it('14 dias a partir de hoje: fim de semana não executa, antes da data inicial e depois da final também não', async () => {
    const s = await setup(100);
    const p = await preview(s, k.numbers, { startDate: '2026-03-11', endDate: '2026-03-17' });
    expect(p.calendar).toHaveLength(14);
    const state = new Map(p.calendar.map((d) => [d.date, d]));
    expect(state.get('2026-03-10')).toMatchObject({ state: 'before_start', capacity: 0 });
    expect(state.get('2026-03-11')).toMatchObject({ state: 'runs', weekday: 3, capacity: 60 });
    expect(state.get('2026-03-13')).toMatchObject({ state: 'runs', capacity: 60 });
    expect(state.get('2026-03-14')).toMatchObject({ state: 'not_allowed', weekday: 6, capacity: 0 });
    expect(state.get('2026-03-15')).toMatchObject({ state: 'not_allowed', weekday: 7 });
    expect(state.get('2026-03-16')).toMatchObject({ state: 'runs', capacity: 60 });
    expect(state.get('2026-03-17')).toMatchObject({ state: 'runs' });
    expect(state.get('2026-03-18')).toMatchObject({ state: 'after_end', capacity: 0 });
  });

  it('o calendário de uma campanha criada segue a mesma conta (e usa só os números conectados)', async () => {
    const s = await setup(50);
    const detail = await k.startCampaignAt(NOW, s.automationId, s.listId, k.numbers, {
      daysOfWeek: [1, 2, 3, 4, 5],
    });
    await setStatus(k.numbers[2], 'close');
    const cal = await campaignCalendar(k.t.db, s.automationId, detail.id, 7, NOW);
    expect(cal.days).toHaveLength(7);
    expect(cal.days[0]).toMatchObject({ date: TODAY, state: 'runs', capacity: 40 }); // hoje: dois números conectados
    expect(cal.days.find((d) => d.date === '2026-03-14')?.state).toBe('not_allowed');
    expect(cal.estimate).toMatchObject({
      status: 'ok',
      eligible: 50,
      connectedNumbers: 2,
      capacityPerDay: 40,
    });
  });

  it('a API do calendário: só quem gerencia, 404 fora da automação, dias de 1 a 60', async () => {
    const s = await setup(20);
    const detail = await k.startCampaignAt(NOW, s.automationId, s.listId, [k.numbers[0]]);
    const url = `/api/automations/${s.automationId}/campaigns/${detail.id}/calendar`;
    expect((await k.ana.get(url)).statusCode).toBe(403);
    const ok = await k.admin.get(`${url}?days=7`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().days).toHaveLength(7);
    expect((await k.admin.get(url)).json().days).toHaveLength(14);
    expect((await k.admin.get(`${url}?days=0`)).statusCode).toBe(400);
    expect((await k.admin.get(`${url}?days=61`)).statusCode).toBe(400);
    expect(
      (await k.admin.get(`/api/automations/${s.automationId + 99}/campaigns/${detail.id}/calendar`))
        .statusCode,
    ).toBe(404);
  });
});

describe('prévia via API', () => {
  it('POST /preview: público, números, capacidade e estimativa; só quem gerencia; corpo validado', async () => {
    const s = await setup(12);
    const url = `/api/automations/${s.automationId}/campaigns/preview`;
    const body = { listId: s.listId, instanceIds: [k.numbers[0], k.numbers[1]], startDate: TODAY };
    expect((await k.ana.post(url, body)).statusCode).toBe(403);
    const r = await k.admin.post(url, body);
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json() as CampaignPreview;
    expect(p.audience).toMatchObject({
      total: 12,
      eligible: 12,
      blocked: 0,
      noWhatsapp: 0,
      participated: 0,
      inCooldown: 0,
    });
    expect(p.list?.id).toBe(s.listId);
    expect(p.dailyCapacity).toBe(40);
    expect(p.estimate.eligible).toBe(12);
    expect(p.calendar).toHaveLength(14);
    expect(p.schedule.state).toMatch(/scheduled|running|waiting/);
    expect((await k.admin.post(url, { ...body, instanceIds: [] })).statusCode).toBe(400);
    expect((await k.admin.post(url, { ...body, dailyLimitPerNumber: 21 })).statusCode).toBe(400);
    expect((await k.admin.post(url, { ...body, daysOfWeek: [] })).statusCode).toBe(400);
    expect((await k.admin.post(url, { ...body, filters: { ddd: ['4'] } })).statusCode).toBe(400);
    expect(
      (await k.admin.post(url, { ...body, listId: '00000000-0000-0000-0000-000000000000' })).statusCode,
    ).toBe(404);
    // A prévia não cria nada: nem campanha, nem participação, nem cota gasta.
    expect((await k.t.db.selectFrom('automation_campaigns').select('id').execute()).length).toBe(0);
    expect((await k.t.db.selectFrom('automation_runs').select('id').execute()).length).toBe(0);
  });
});

describe('contadores do painel (stats)', () => {
  it('processados, aguardando, concluídos, falharam, sem WhatsApp e números sem cota, tudo agregado no servidor', async () => {
    const s = await setup(6);
    const [n1] = k.numbers;
    // O primeiro lead da fila não tem WhatsApp (a Evolution de mentira responde "não existe" no final 9999).
    await k.t.db
      .updateTable('leads')
      .set({ phone: '5541999999999' })
      .where('id', '=', s.leadIds[0] as number)
      .execute();
    const detail = await k.startCampaignAt(NOW, s.automationId, s.listId, [n1], { dailyLimitPerNumber: 2 });
    await k.simulate({ from: 600, to: 965 });
    const stats = await campaignStats(k.t.db, s.automationId, detail.id, at(16, 5));
    expect(stats).toMatchObject({
      processed: 3, // o sem WhatsApp + os dois contatos
      completed: 2,
      failed: 1,
      noWhatsapp: 1,
      cancelled: 0,
      waiting: 0,
      blocked: 0,
      numbers: 1,
      numbersFull: 1, // o número bateu a cota de hoje (2/2)
      numbersDisconnected: 0,
    });
    expect(stats.audience).toMatchObject({ total: 6, participated: 3, eligible: 3 });
    expect(stats.explain.join(' ')).toMatch(/atingiram a cota de hoje/);
    expect(stats.schedule.state).toBe('waiting');
  });

  it('bloqueados depois da reserva, números desconectados e leads em cooldown aparecem nos contadores', async () => {
    const s = await setup(4);
    const detail = await k.startCampaignAt(NOW, s.automationId, s.listId, [k.numbers[0], k.numbers[1]]);
    await k.tick(at(9, 0)); // reserva um lead por número
    const reserved = await k.campaignRuns(detail.id);
    expect(reserved.length).toBeGreaterThan(0);
    const phone = (
      await k.t.db
        .selectFrom('leads')
        .select('phone')
        .where('id', '=', reserved[0]?.lead_id as number)
        .executeTakeFirstOrThrow()
    ).phone;
    await k.t.db.insertInto('blocked_phones').values({ phone }).execute();
    await k.tick(at(10, 1));
    await setStatus(k.numbers[1], 'close');
    const stats = await campaignStats(k.t.db, s.automationId, detail.id, at(10, 2));
    expect(stats.blocked).toBe(1); // participação cancelada porque o lead entrou em "não contatar"
    expect(stats.cancelled).toBeGreaterThanOrEqual(1);
    expect(stats.audience.blocked).toBe(1);
    expect(stats.numbersDisconnected).toBe(1);
    expect(stats.explain.join(' ')).toMatch(/1 número\(s\) desconectado\(s\)/);
    // Tudo desconectado: a campanha explica que está parada por isso.
    await setStatus(k.numbers[0], 'close');
    const all = await campaignStats(k.t.db, s.automationId, detail.id, at(10, 3));
    expect(all.explain.join(' ')).toMatch(/Nenhum número da campanha está conectado/);
  });

  it('campanha agendada, pausada e encerrada explicam o estado em palavras', async () => {
    const s = await setup(5);
    const detail = await k.startCampaignAt(NOW, s.automationId, s.listId, [k.numbers[0]], {
      startDate: '2026-03-12',
    });
    const scheduled = await campaignStats(k.t.db, s.automationId, detail.id, NOW);
    expect(scheduled.schedule).toMatchObject({
      state: 'scheduled',
      reason: 'Agendada: começa em 12/03/2026.',
    });
    expect(scheduled.explain[0]).toBe('Agendada: começa em 12/03/2026.');
  });

  it('a API de contadores responde só para quem gerencia', async () => {
    const s = await setup(5);
    const detail = await k.startCampaignAt(NOW, s.automationId, s.listId, [k.numbers[0]]);
    const url = `/api/automations/${s.automationId}/campaigns/${detail.id}/stats`;
    expect((await k.ana.get(url)).statusCode).toBe(403);
    const r = await k.admin.get(url);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ processed: 0, numbers: 1, audience: { total: 5 } });
    expect((await k.admin.get(`/api/automations/${s.automationId}/campaigns/999999/stats`)).statusCode).toBe(
      404,
    );
  });
});
