import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '../../src/server/db';
import { startJobs } from '../../src/server/jobs/scheduler';
import {
  getCampaign,
  RESUME_GAP_SECONDS,
  resumeCampaign,
} from '../../src/server/modules/automations/campaigns';
import { runAutomationCycle } from '../../src/server/modules/automations/executor';
import {
  advanceCampaigns,
  MAX_RESERVATIONS_PER_CYCLE,
  reserveNext,
} from '../../src/server/modules/automations/queue';
import { CYCLE_SECONDS } from '../../src/server/modules/automations/schedule';
import { addDays, spInstant, spTime } from '../../src/server/modules/automations/window';
import type { CampaignDetail, CampaignItem, CampaignPreview } from '../../src/shared/api';
import { at, campaignKit, DAY, NEXT_DAY, type StepSpec } from '../campaign-kit';

// Campanhas de automação contra o PostgreSQL de testes e a Evolution de mentira. O relógio é injetado: cada
// `tick(now)` roda um ciclo da fila e do executor NAQUELE instante, então dias inteiros (10:00 às 16:00) rodam em
// segundos. Nada aqui espera o tempo passar de verdade.

const k = campaignKit();

const destination = (call: { body: unknown }) =>
  String((call.body as { number: string }).number).split('@')[0];
const instanceName = (call: { url: string }) => call.url.split('/').pop() ?? '';

interface Setup {
  automationId: number;
  listId: string;
  leadIds: number[];
  phones: string[];
  campaignId: number;
  audios: { id: number; bytes: Buffer }[];
}

/** Automação ativa (sorteio de áudio por padrão), lista de leads livres e campanha já iniciada. */
async function setup(o: {
  leads: number;
  numbers?: number[];
  audios?: number;
  steps?: (audios: { id: number }[]) => StepSpec[];
  extra?: Record<string, unknown>;
}): Promise<Setup> {
  const audios: Setup['audios'] = [];
  for (let i = 0; i < (o.audios ?? 3); i++) audios.push(await k.uploadAudio(`Áudio ${i + 1}`));
  const automationId = await k.makeAutomation(o.steps ? o.steps(audios) : [{ audio: 'random' }]);
  const list = await k.newList(o.leads);
  const started = await k.startCampaign(
    automationId,
    list.listId,
    o.numbers ?? [k.numbers[0], k.numbers[1]],
    o.extra,
  );
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  return { automationId, ...list, campaignId: started.body.id, audios };
}

const detail = async (s: Setup, now = new Date()) => getCampaign(k.t.db, s.automationId, s.campaignId, now);
const statusOf = async (campaignId: number) =>
  (
    await k.t.db
      .selectFrom('automation_campaigns')
      .select(['status', 'end_reason'])
      .where('id', '=', campaignId)
      .executeTakeFirstOrThrow()
  ).status;

/** Contatos de cada número por dia, lidos da COTA (wa_instance_daily_usage): manual + automático + incerto. */
const perNumberPerDay = async (_campaignId?: number) => {
  const rows = await sql<{ instance_id: number; day: string; n: number }>`
    SELECT instance_id, usage_date::text AS day, total_contacts AS n FROM wa_instance_daily_usage ORDER BY instance_id, usage_date`.execute(
    k.t.db,
  );
  return rows.rows.map((r) => ({ instance: r.instance_id, day: r.day, n: Number(r.n) }));
};

// ---------- 1. prévia e início ----------

describe('campanha: prévia e início', () => {
  it('a prévia conta só os leads elegíveis e mostra números, capacidade e áudios ativos', async () => {
    await k.uploadAudio('A');
    const automationId = await k.makeAutomation([{ audio: 'random' }]);
    const list = await k.newList(12);
    await k.newList(5, { name: 'Outra lista' }); // não entra: é de outra lista
    const [l0, , l2, l3, l4, l5, l6, l7] = list.leadIds as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const db = k.t.db;
    await db.updateTable('leads').set({ anonymized_at: new Date() }).where('id', '=', l0).execute();
    await db
      .insertInto('blocked_phones')
      .values({ phone: list.phones[1] as string })
      .execute();
    await db.updateTable('leads').set({ phone_type: 'fixo' }).where('id', '=', l2).execute();
    await db
      .updateTable('leads')
      .set({ assigned_to: k.anaId, assigned_at: new Date() })
      .where('id', '=', l3)
      .execute();
    await db
      .updateTable('leads')
      .set({ status: 'chamado', called_at: new Date(), result: 'enviado' })
      .where('id', '=', l4)
      .execute();
    await db
      .insertInto('automation_runs')
      .values({
        automation_id: automationId,
        lead_id: l5,
        instance_id: k.numbers[0],
        status: 'completed',
        completed_at: new Date(),
      })
      .execute();
    await db.updateTable('leads').set({ status: 'bloqueado' }).where('id', '=', l6).execute();
    await db
      .insertInto('automation_runs')
      .values({ automation_id: automationId, lead_id: l7, instance_id: k.numbers[0], status: 'pending' })
      .execute();

    const previewOf = async (extra: Record<string, unknown> = {}) =>
      (
        await k.admin.post(`/api/automations/${automationId}/campaigns/preview`, {
          listId: list.listId,
          instanceIds: [k.numbers[0], k.numbers[1]],
          ...extra,
        })
      ).json() as CampaignPreview;
    const preview = await previewOf();
    expect(preview.eligibleLeads).toBe(4);
    expect(preview.list).toMatchObject({ id: list.listId });
    expect(preview.numbers.map((n) => n.id)).toEqual([k.numbers[0], k.numbers[1]]);
    expect(preview).toMatchObject({ connectedNumbers: 2, dailyCapacity: 40, activeAudios: 1 });
    expect(preview.numbers[0]).toMatchObject({
      dailyLimit: 20,
      usedToday: 0,
      remainingToday: 20,
      connected: true,
    });

    const smaller = await previewOf({ dailyLimitPerNumber: 10 });
    expect(smaller.dailyCapacity).toBe(20);

    await db.updateTable('wa_instances').set({ status: 'close' }).where('id', '=', k.numbers[1]).execute();
    const one = await previewOf();
    expect(one).toMatchObject({ connectedNumbers: 1, dailyCapacity: 20 });
    expect(one.numbers[1]).toMatchObject({ connected: false });
  });

  it('iniciar: o corpo é validado e só quem gerencia automações pode', async () => {
    const audio = await k.uploadAudio('A');
    const automationId = await k.makeAutomation([{ audio: audio.id }]);
    const list = await k.newList(3);
    const url = `/api/automations/${automationId}/campaigns`;
    const good = { listId: list.listId, instanceIds: [k.numbers[0]] };
    for (const bad of [
      {},
      { ...good, listId: 'nao-e-uuid' },
      { ...good, instanceIds: [] },
      { ...good, instanceIds: [k.numbers[0], k.numbers[0]] },
      { ...good, windowStart: '16:00', windowEnd: '10:00' },
      { ...good, windowStart: '10:00', windowEnd: '10:00' },
      { ...good, windowStart: '25:00' },
      { ...good, dailyLimitPerNumber: 0 },
      { ...good, dailyLimitPerNumber: 501 },
      { ...good, dailyLimitPerNumber: 2.5 },
    ]) {
      const r = await k.admin.post(url, bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await k.ana.post(url, good)).statusCode).toBe(403);
    expect((await k.ana.get(url)).statusCode).toBe(403);
    expect(
      (await k.ana.post(`${url}/preview`, { listId: list.listId, instanceIds: [k.numbers[0]] })).statusCode,
    ).toBe(403);
    expect((await k.ana.post(`${url}/1/pause`, {})).statusCode).toBe(403);
    expect(await k.t.db.selectFrom('automation_campaigns').select('id').execute()).toEqual([]);
  });

  it('recusa: automação que não está ativa, arquivada ou incompleta; lista ou número que não existem', async () => {
    const audio = await k.uploadAudio('A');
    const list = await k.newList(3);
    const body = { listId: list.listId, instanceIds: [k.numbers[0]] };
    const url = (id: number) => `/api/automations/${id}/campaigns`;

    const draft = await k.makeAutomation([{ audio: audio.id }], { status: 'draft' });
    expect((await k.admin.post(url(draft), body)).statusCode).toBe(409);
    const paused = await k.makeAutomation([{ audio: audio.id }], { status: 'paused' });
    expect((await k.admin.post(url(paused), body)).statusCode).toBe(409);
    expect((await k.admin.post(url(999_999), body)).statusCode).toBe(404);

    const archived = await k.makeAutomation([{ audio: audio.id }]);
    await k.admin.post(`/api/automations/${archived}/archive`, {});
    expect((await k.admin.post(url(archived), body)).statusCode).toBe(409);

    // Etapa que ficou incompleta (o áudio fixo foi excluído) impede a campanha.
    const orphan = await k.uploadAudio('Vai sair');
    const broken = await k.makeAutomation([{ audio: orphan.id }]);
    await k.admin.post(`/api/audios/${orphan.id}/delete`, {});
    expect((await k.admin.post(url(broken), body)).statusCode).toBe(409);

    const ok = await k.makeAutomation([{ audio: audio.id }]);
    expect(
      (await k.admin.post(url(ok), { ...body, listId: '11111111-1111-4111-8111-111111111111' })).statusCode,
    ).toBe(404);
    expect((await k.admin.post(url(ok), { ...body, instanceIds: [999_999] })).statusCode).toBe(404);
    await k.t.db
      .updateTable('lists')
      .set({ archived_at: new Date() })
      .where('id', '=', list.listId)
      .execute();
    expect((await k.admin.post(url(ok), body)).statusCode).toBe(409);
    expect(await k.t.db.selectFrom('automation_campaigns').select('id').execute()).toEqual([]);
  });

  it('recusa: lista sem leads elegíveis, sem número conectado, e sorteio sem nenhum áudio ativo', async () => {
    const audio = await k.uploadAudio('A');
    const automationId = await k.makeAutomation([{ audio: 'random' }]);
    const url = `/api/automations/${automationId}/campaigns`;

    const empty = await k.newList(2);
    await k.t.db
      .updateTable('leads')
      .set({ assigned_to: k.anaId, assigned_at: new Date() })
      .where('list_id', '=', empty.listId)
      .execute();
    const none = await k.admin.post(url, { listId: empty.listId, instanceIds: [k.numbers[0]] });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toMatch(/elegíveis/);

    const list = await k.newList(3);
    await k.t.db
      .updateTable('wa_instances')
      .set({ status: 'close' })
      .where('id', '=', k.numbers[0])
      .execute();
    const off = await k.admin.post(url, { listId: list.listId, instanceIds: [k.numbers[0]] });
    expect(off.statusCode).toBe(409);
    expect(off.json().error).toMatch(/conectado/);
    // Um conectado basta: o desconectado fica fora do rodízio até voltar.
    const mixed = await k.admin.post(url, { listId: list.listId, instanceIds: [k.numbers[0], k.numbers[1]] });
    expect(mixed.statusCode, mixed.body).toBe(201);
    await k.admin.post(`${url}/${mixed.json().id}/stop`, {});

    await k.admin.patch(`/api/audios/${audio.id}`, { active: false });
    const silent = await k.admin.post(url, { listId: list.listId, instanceIds: [k.numbers[1]] });
    expect(silent.statusCode).toBe(409);
    expect(silent.json().error).toMatch(/áudio/);
  });

  it('só uma campanha viva por automação: dois cliques ao mesmo tempo criam uma só', async () => {
    const audio = await k.uploadAudio('A');
    const automationId = await k.makeAutomation([{ audio: audio.id }]);
    const list = await k.newList(6);
    const url = `/api/automations/${automationId}/campaigns`;
    const body = { listId: list.listId, instanceIds: [k.numbers[0], k.numbers[1]] };
    const results = await Promise.all([
      k.admin.post(url, body),
      k.admin.post(url, body),
      k.admin.post(url, body),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    const rows = await k.t.db
      .selectFrom('automation_campaigns')
      .select(['id', 'status'])
      .where('automation_id', '=', automationId)
      .execute();
    expect(rows).toHaveLength(1);
    // Encerrada a anterior, dá para iniciar outra.
    const first = results.find((r) => r.statusCode === 201)?.json() as CampaignDetail;
    expect((await k.admin.post(`${url}/${first.id}/stop`, {})).statusCode).toBe(200);
    expect((await k.admin.post(url, body)).statusCode).toBe(201);
  });

  it('a campanha guarda os padrões (10:00 às 16:00, 20 por número) e responde com o detalhe completo', async () => {
    const s = await setup({ leads: 5 });
    const item = (
      await k.admin.get(`/api/automations/${s.automationId}/campaigns/${s.campaignId}`)
    ).json() as CampaignDetail;
    expect(item).toMatchObject({
      id: s.campaignId,
      automationId: s.automationId,
      status: 'active',
      windowStart: '10:00',
      windowEnd: '16:00',
      dailyLimitPerNumber: 20,
      instanceIds: [k.numbers[0], k.numbers[1]],
      counts: { total: 0, waiting: 0, completed: 0, cancelled: 0, failed: 0 },
      eligibleLeads: 5,
      dailyCapacity: 40,
      nextSends: [],
    });
    expect(item.list?.id).toBe(s.listId);
    expect(item.numbers).toHaveLength(2);
    const list = (await k.admin.get(`/api/automations/${s.automationId}/campaigns`)).json() as CampaignItem[];
    expect(list.map((c) => c.id)).toEqual([s.campaignId]);
    // Ids que não combinam respondem 404.
    expect(
      (await k.admin.get(`/api/automations/${s.automationId + 999}/campaigns/${s.campaignId}`)).statusCode,
    ).toBe(404);
    expect(
      (await k.admin.get(`/api/automations/${s.automationId}/campaigns/${s.campaignId + 999}`)).statusCode,
    ).toBe(404);
    expect((await k.admin.get(`/api/automations/${s.automationId}/campaigns/abc`)).statusCode).toBe(404);
    expect(
      (await k.admin.post(`/api/automations/${s.automationId}/campaigns/${s.campaignId + 999}/pause`, {}))
        .statusCode,
    ).toBe(404);
  });
});

// ---------- 2. números, limite por dia e distribuição ----------

describe('campanha: números e limite diário', () => {
  it('cada número recebe no máximo 20 leads por dia; o resto fica para o dia seguinte e o dia novo recomeça sozinho', async () => {
    const s = await setup({ leads: 50 });
    await k.simulate({ day: DAY });

    const day1 = await perNumberPerDay(s.campaignId);
    expect(day1).toHaveLength(2);
    for (const row of day1) {
      expect(row.n, `número ${row.instance}`).toBe(20);
      expect(row.day).toBe(DAY);
    }
    expect(k.sendsByNumber()).toEqual({ 'whatsapp-01': 20, 'whatsapp-02': 20 });
    expect(k.sends()).toHaveLength(40);
    // Cada lead recebeu no máximo UMA mensagem (o destino nunca se repete).
    expect(new Set(k.sends().map(destination)).size).toBe(40);
    const usage = await detail(s, at(16, 5));
    expect(usage.numbers.map((n) => [n.usedToday, n.remainingToday])).toEqual([
      [20, 0],
      [20, 0],
    ]);
    expect(usage.eligibleLeads).toBe(10);
    expect(await statusOf(s.campaignId)).toBe('active');
    // Fora da janela e com o limite batido, nada muda: mais ciclos não enviam mais nada.
    await k.simulate({ day: DAY, from: 970, to: 1100, step: 10 });
    expect(k.sends()).toHaveLength(40);

    // Dia seguinte: a contagem recomeça sozinha (sem ninguém zerar contador) e sobram os 10 últimos.
    await k.simulate({ day: NEXT_DAY });
    expect(k.sends()).toHaveLength(50);
    const all = await perNumberPerDay(s.campaignId);
    for (const row of all) expect(row.n).toBeLessThanOrEqual(20);
    expect(all.filter((r) => r.day === NEXT_DAY).reduce((sum, r) => sum + r.n, 0)).toBe(10);
    expect(new Set(k.sends().map(destination)).size).toBe(50);
    // A lista acabou: a campanha termina sozinha.
    expect(await statusOf(s.campaignId)).toBe('finished');
    const ended = await k.t.db
      .selectFrom('automation_campaigns')
      .select(['end_reason', 'ended_at'])
      .where('id', '=', s.campaignId)
      .executeTakeFirstOrThrow();
    expect(ended.end_reason).toBe('lista_esgotada');
    expect(ended.ended_at).not.toBeNull();
  });

  it('o limite é o escolhido (5 por número), separado do limite de leads do atendente', async () => {
    const before = await k.t.db.selectFrom('settings').select('daily_pull_limit').executeTakeFirst();
    const s = await setup({ leads: 30, extra: { dailyLimitPerNumber: 5 } });
    await k.simulate({ day: DAY });
    expect(k.sendsByNumber()).toEqual({ 'whatsapp-01': 5, 'whatsapp-02': 5 });
    const after = await k.t.db.selectFrom('settings').select('daily_pull_limit').executeTakeFirst();
    expect(after).toEqual(before); // a configuração dos atendentes não foi tocada
    const usage = await detail(s, at(16, 5));
    expect(usage.numbers.every((n) => n.dailyLimit === 5 && n.usedToday === 5)).toBe(true);
    // O número chegou ao teto da campanha (5): um registro por número, com a origem e o total.
    const audits = await k.numberLimitAudits({ campaignId: s.campaignId });
    expect(audits.filter((a) => a.details.situacao === 'atingido')).toHaveLength(2);
    expect(audits[0]?.details).toMatchObject({
      origem: 'campanha',
      total: 5,
      limite: 5,
      automatico: 5,
      manual: 0,
    });
  });

  it('o trabalho se divide por igual entre os números (o menos usado vai primeiro)', async () => {
    await setup({ leads: 30, numbers: [...k.numbers] });
    await k.simulate({ day: DAY });
    const by = k.sendsByNumber();
    expect(k.sends()).toHaveLength(30);
    for (const name of k.names) {
      expect(by[name], name).toBeGreaterThanOrEqual(9);
      expect(by[name], name).toBeLessThanOrEqual(11);
    }
  });

  it('o próximo lead vai para o número MENOS usado (uso relativo ao limite)', async () => {
    const s = await setup({ leads: 12 });
    // O número 1 já recebeu 7 leads hoje (de outra campanha, por exemplo); o 2 recebeu 1.
    const filler = await k.newList(8);
    const other = await k.makeAutomation([{ audio: 'random' }]);
    const otherCampaign = await k.t.db
      .insertInto('automation_campaigns')
      .values({
        automation_id: other,
        list_id: filler.listId,
        instance_ids: [k.numbers[0], k.numbers[1]],
        window_start_min: 600,
        window_end_min: 960,
        daily_limit: 20,
        start_date: DAY,
        status: 'stopped',
        ended_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const [i, leadId] of filler.leadIds.entries()) {
      await k.t.db
        .insertInto('automation_runs')
        .values({
          automation_id: other,
          lead_id: leadId,
          instance_id: i < 7 ? k.numbers[0] : k.numbers[1],
          campaign_id: otherCampaign.id,
          slot_date: DAY,
          status: 'completed',
          completed_at: new Date(),
        })
        .execute();
    }
    // A cota do dia é do banco (contatos EFETIVOS): o uso de hoje é o que a fila compara, não as participações antigas.
    await k.seedUsage(k.numbers[0], DAY, { automatic: 7 });
    await k.seedUsage(k.numbers[1], DAY, { automatic: 1 });
    const first = await advanceCampaigns(k.t.db, { now: at(10), maxReservations: 1 });
    expect(first.reserved).toBe(1);
    const runs = await k.campaignRuns(s.campaignId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.instance_id).toBe(k.numbers[1]);
  });

  it('concorrência: reservas simultâneas nunca passam do limite (uma campanha)', async () => {
    const s = await setup({ leads: 20, numbers: [k.numbers[0]], extra: { dailyLimitPerNumber: 3 } });
    // O número já fez 2 contatos hoje (um manual, um automático): resta 1 vaga.
    await k.seedUsage(k.numbers[0], DAY, { manual: 1, automatic: 1 });
    // Vinte pedidos ao mesmo tempo para reservar o próximo lead: a fila é curta, então só UM lead fica reservado.
    const disputes = await Promise.all(
      Array.from({ length: 20 }, () => reserveNext(k.t.db, s.campaignId, k.numbers[0], at(10))),
    );
    expect(disputes.filter((d) => d.kind === 'reserved')).toHaveLength(1);
    expect(disputes.filter((d) => d.kind !== 'reserved').every((d) => d.kind === 'busy')).toBe(true);
    expect((await k.campaignRuns(s.campaignId)).length).toBe(1);
    // Reservar NÃO consome a cota: o dia continua em 2 de 3 até o envio de verdade.
    expect(await k.usageRow(k.numbers[0], DAY)).toMatchObject({ manual: 1, automatic: 1, total: 2 });
    // O envio está espalhado pelo resto do dia (só 1 vaga sobra); quando chega a hora, sai e o número fica no teto.
    await k.tick(at(14, 0));
    expect(await k.usageRow(k.numbers[0], DAY)).toMatchObject({ manual: 1, automatic: 2, total: 3 });
    const again = await Promise.all(
      Array.from({ length: 10 }, () => reserveNext(k.t.db, s.campaignId, k.numbers[0], at(11))),
    );
    expect(again.every((d) => d.kind === 'limit')).toBe(true);
    expect((await k.campaignRuns(s.campaignId)).length).toBe(1);
  });

  it('concorrência: duas campanhas no MESMO número disputam a última vaga (a cota é do número)', async () => {
    const a = await setup({ leads: 10, numbers: [k.numbers[0]], extra: { dailyLimitPerNumber: 3 } });
    const b = await setup({ leads: 10, numbers: [k.numbers[0]], extra: { dailyLimitPerNumber: 3 } });
    await k.seedUsage(k.numbers[0], DAY, { manual: 2 }); // resta UMA vaga para as duas campanhas
    // As duas reservam um lead (reservar não gasta cota), com o envio marcado para o mesmo instante.
    expect((await reserveNext(k.t.db, a.campaignId, k.numbers[0], at(10))).kind).toBe('reserved');
    expect((await reserveNext(k.t.db, b.campaignId, k.numbers[0], at(10))).kind).toBe('reserved');
    await k.t.db
      .updateTable('automation_runs')
      .set({ next_run_at: at(10) })
      .execute();
    // Vários ciclos ao mesmo tempo, dois deles em "processos" diferentes: só UMA das duas recebe a vaga.
    const other = createDb(createPool(k.t.url, 4));
    try {
      await Promise.all([
        runAutomationCycle(k.t.db, { now: at(10, 5), batchSize: 5 }),
        runAutomationCycle(other, { now: at(10, 5), batchSize: 5 }),
        runAutomationCycle(k.t.db, { now: at(10, 5), batchSize: 5 }),
      ]);
    } finally {
      await other.destroy();
    }
    expect(k.sends()).toHaveLength(1);
    expect(await k.usageRow(k.numbers[0], DAY)).toMatchObject({ manual: 2, automatic: 1, total: 3 });
    // No ciclo seguinte a perdedora vê o número cheio e vai para amanhã (quem perdeu a corrida só espera alguns segundos).
    await runAutomationCycle(k.t.db, { now: at(10, 6), batchSize: 5 });
    // A que perdeu a vaga NÃO foi enviada: espera o dia seguinte (a cota de amanhã), sem gastar a de hoje.
    const losers = [...(await k.campaignRuns(a.campaignId)), ...(await k.campaignRuns(b.campaignId))].filter(
      (r) => r.status === 'pending',
    );
    expect(losers).toHaveLength(1);
    expect(losers[0]?.next_run_at?.getTime()).toBeGreaterThanOrEqual(at(10, 0, 0, NEXT_DAY).getTime());
  });

  it('número desconectado sai do rodízio e o que já foi reservado nele NÃO muda de número', async () => {
    const s = await setup({ leads: 10 });
    await k.tick(at(10));
    const first = await k.campaignRuns(s.campaignId);
    expect(first).toHaveLength(2);
    const forTwo = first.find((r) => r.instance_id === k.numbers[1]);
    expect(forTwo).toBeTruthy();

    await k.t.db
      .updateTable('wa_instances')
      .set({ status: 'close' })
      .where('id', '=', k.numbers[1])
      .execute();
    await k.simulate({ from: 601, to: 700 });
    const runs = await k.campaignRuns(s.campaignId);
    const stuck = runs.find((r) => r.id === forTwo?.id);
    expect(stuck).toMatchObject({ status: 'pending', instance_id: k.numbers[1] }); // não foi passado para outro número
    // Nada saiu pelo número desconectado, e nenhum lead NOVO foi reservado para ele.
    expect(k.sendsByNumber()['whatsapp-02']).toBeUndefined();
    expect(runs.filter((r) => r.instance_id === k.numbers[1])).toHaveLength(1);
    expect(runs.filter((r) => r.instance_id === k.numbers[0]).length).toBeGreaterThan(1);
    const during = await detail(s, at(11));
    expect(during.numbers.find((n) => n.id === k.numbers[1])).toMatchObject({ connected: false });
    expect(during.dailyCapacity).toBe(20); // só o conectado conta

    // Ao reconectar, o lead que já era dele sai por ele (e por nenhum outro).
    await k.t.db.updateTable('wa_instances').set({ status: 'open' }).where('id', '=', k.numbers[1]).execute();
    await k.simulate({ from: 701, to: 705 });
    expect(k.sendsByNumber()['whatsapp-02']).toBeGreaterThanOrEqual(1);
    const phone = s.phones[s.leadIds.indexOf(stuck?.lead_id as number)];
    const call = k.sends().find((c) => destination(c) === phone);
    expect(call && instanceName(call)).toBe('whatsapp-02');
  });

  it('número excluído: a participação é cancelada, a vaga volta e a campanha segue pelos outros', async () => {
    await k.hook('connection.update', { state: 'open', wuid: '5511977777777@s.whatsapp.net' }, 'whatsapp-99');
    const extra = await k.t.db
      .selectFrom('wa_instances')
      .select('id')
      .where('name', '=', 'whatsapp-99')
      .executeTakeFirstOrThrow();
    const s = await setup({ leads: 10, numbers: [k.numbers[0], extra.id] });
    await k.tick(at(9, 0)); // só reserva: o envio é às 10:00, então o número ainda não tem conversa
    const doomed = (await k.campaignRuns(s.campaignId)).find((r) => r.instance_id === extra.id);
    expect(doomed).toBeTruthy();
    await k.t.db.deleteFrom('wa_instances').where('id', '=', extra.id).execute();
    await k.simulate({ from: 601, to: 640 });
    const runs = await k.campaignRuns(s.campaignId);
    expect(runs.find((r) => r.id === doomed?.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'numero_removido',
    });
    expect(k.sendsByNumber()['whatsapp-99']).toBeUndefined();
    // A participação cancelada sem envio não gasta vaga; os leads seguintes saem pelo número que sobrou.
    const view = await detail(s, at(10, 40));
    expect(view.numbers.map((n) => n.id)).toEqual([k.numbers[0]]);
    expect(runs.filter((r) => r.instance_id === k.numbers[0]).length).toBeGreaterThan(1);
    expect(await statusOf(s.campaignId)).toBe('active');
  });

  it('não cria uma linha por lead: com 500 leads só existe a fila curta (uma por número)', async () => {
    const s = await setup({ leads: 500 });
    await k.tick(at(10));
    expect(await k.campaignRuns(s.campaignId)).toHaveLength(2); // uma por número, não 500
    await k.tick(at(10, 0, 20));
    await k.tick(at(10, 0, 40));
    // Quando um lead é enviado, o número libera a vaga para o próximo: a fila nunca passa de uma por número.
    const early = await k.campaignRuns(s.campaignId);
    expect(early.length).toBeLessThanOrEqual(6);
    expect(early.filter((r) => r.status === 'pending').length).toBeLessThanOrEqual(2);
    // Horas depois, continua curta: só existem os leads já atendidos e os que esperam a vez.
    await k.simulate({ from: 601, to: 780, step: 5 });
    const runs = await k.campaignRuns(s.campaignId);
    expect(runs.length).toBeLessThan(2 * 20 + 1);
    const waiting = runs.filter((r) => r.status === 'pending');
    expect(waiting.length).toBeGreaterThanOrEqual(1);
    expect(waiting.length).toBeLessThanOrEqual(2);
    expect(MAX_RESERVATIONS_PER_CYCLE).toBeLessThanOrEqual(10);
  });

  it('a seleção segue a ordem do id do lead (previsível, sem sorteio)', async () => {
    const s = await setup({ leads: 12, numbers: [k.numbers[0]], audios: 1 });
    await k.simulate({ from: 600, to: 965 });
    const order = (await k.campaignRuns(s.campaignId)).map((r) => r.lead_id);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(order).toEqual(s.leadIds.slice(0, order.length));
  });
});

// ---------- 3. Evolution: número, áudio e destinatário certos ----------

describe('campanha: o que chega na Evolution', () => {
  it('cada envio vai para o lead certo, pelo número da participação e com o áudio gravado no histórico', async () => {
    const s = await setup({ leads: 14, audios: 3, extra: { dailyLimitPerNumber: 7 } });
    await k.simulate({ day: DAY });
    const calls = k.sends();
    expect(calls).toHaveLength(14);
    expect(calls.every((c) => c.url.startsWith('/message/sendWhatsAppAudio/'))).toBe(true);
    expect(calls.every((c) => c.apikey === 'chave-teste')).toBe(true);

    const runs = await k.t.db
      .selectFrom('automation_runs as r')
      .innerJoin('wa_instances as i', 'i.id', 'r.instance_id')
      .innerJoin('leads as l', 'l.id', 'r.lead_id')
      .innerJoin('automation_step_runs as sr', 'sr.automation_run_id', 'r.id')
      .select([
        'r.id',
        'i.name as instance',
        'l.phone',
        'sr.audio_id',
        'sr.audio_label',
        'sr.message_id',
        'r.status',
      ])
      .where('r.campaign_id', '=', s.campaignId)
      .execute();
    expect(runs).toHaveLength(14);
    const bytesById = new Map(s.audios.map((a) => [a.id, a.bytes.toString('base64')]));
    const activeIds = new Set(s.audios.map((a) => a.id));
    for (const run of runs) {
      expect(run.status).toBe('completed');
      const call = calls.find((c) => destination(c) === run.phone);
      expect(call, `lead ${run.phone}`).toBeTruthy();
      // Número: o da participação. Destinatário: o lead. Áudio: o que ficou registrado no histórico.
      expect(call && instanceName(call)).toBe(run.instance);
      expect(activeIds.has(run.audio_id as number)).toBe(true);
      expect((call as { body: { audio: string } }).body.audio).toBe(bytesById.get(run.audio_id as number));
      expect(run.audio_label).toMatch(/^Áudio \d$/);
      expect(run.message_id).not.toBeNull();
    }
    // Nunca mais de 7 por número (o limite escolhido).
    for (const n of Object.values(k.sendsByNumber())) expect(n).toBeLessThanOrEqual(7);
  });

  it('a mensagem fica gravada na conversa do número que enviou e o primeiro contato é registrado no lead', async () => {
    const s = await setup({ leads: 2, numbers: [k.numbers[0]], audios: 1 });
    await k.simulate({ from: 600, to: 700 });
    const leadId = s.leadIds[0] as number;
    const lead = await k.t.db
      .selectFrom('leads')
      .selectAll()
      .where('id', '=', leadId)
      .executeTakeFirstOrThrow();
    // O mesmo que o "Chamar" faz: chamado, "mensagem enviada", sem atendente (foi o sistema).
    expect(lead).toMatchObject({ status: 'chamado', result: 'enviado', called_by: null, assigned_to: null });
    expect(lead.called_at).not.toBeNull();
    const events = await k.t.db
      .selectFrom('lead_events')
      .select(['type', 'data', 'user_id'])
      .where('lead_id', '=', leadId)
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'chamado', user_id: null });
    expect(events[0]?.data).toMatchObject({ resultado: 'enviado', automatico: true, campanha: s.campaignId });

    const conversation = await k.t.db
      .selectFrom('wa_conversations')
      .select(['id', 'instance_id'])
      .where('lead_id', '=', leadId)
      .execute();
    expect(conversation).toHaveLength(1);
    expect(conversation[0]?.instance_id).toBe(k.numbers[0]);
    const messages = await k.t.db
      .selectFrom('wa_messages')
      .select(['id', 'from_me', 'type'])
      .where('conversation_id', '=', conversation[0]?.id as number)
      .execute();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ from_me: true });
    const stepRun = await k.t.db
      .selectFrom('automation_step_runs as sr')
      .innerJoin('automation_runs as r', 'r.id', 'sr.automation_run_id')
      .select(['sr.message_id', 'sr.status'])
      .where('r.lead_id', '=', leadId)
      .executeTakeFirstOrThrow();
    expect(stepRun).toMatchObject({ status: 'completed', message_id: messages[0]?.id });
    // Ele saiu da fila livre: nenhum atendente recebe este lead ao pegar leads.
    const pulled = (await k.ana.post('/api/queue/pull', { quantity: 10 })).json();
    expect(pulled.leads.map((l: { id: number }) => l.id)).not.toContain(leadId);
  });

  it('"Pegar leads" não entrega um lead que a campanha já reservou', async () => {
    const s = await setup({ leads: 5, numbers: [k.numbers[0]], audios: 1 });
    await k.tick(at(9, 0)); // reserva o primeiro lead (sai às 10:00)
    const reserved = (await k.campaignRuns(s.campaignId))[0]?.lead_id as number;
    expect(reserved).toBe(s.leadIds[0]);
    const pulled = (await k.ana.post('/api/queue/pull', { quantity: 10 })).json();
    const ids = pulled.leads.map((l: { id: number }) => l.id);
    expect(ids).not.toContain(reserved);
    expect(ids).toHaveLength(4);
  });
});

// ---------- 4. a resposta do lead, sem WhatsApp, bloqueio ----------

describe('campanha: lead que responde, sem WhatsApp e bloqueado', () => {
  it('a resposta do lead cancela SÓ a participação dele; a campanha e os outros leads seguem', async () => {
    const s = await setup({
      leads: 30,
      numbers: [k.numbers[0], k.numbers[1]],
      audios: 1,
      steps: (a) => [{ audio: a[0]?.id }, { text: 'Conseguiu ver?', delaySeconds: 3600 }],
    });
    await k.simulate({ from: 600, to: 660 });
    const runsNow = await k.campaignRuns(s.campaignId);
    expect(runsNow.length).toBeGreaterThanOrEqual(2);
    const afterFirst = runsNow.filter((r) => r.current_step === 2 && r.status === 'pending');
    expect(afterFirst.length).toBeGreaterThanOrEqual(2);
    const [a, b] = afterFirst as [(typeof afterFirst)[number], (typeof afterFirst)[number]];
    const phoneOf = (leadId: number) => s.phones[s.leadIds.indexOf(leadId)] as string;
    const nameOf = (id: number | null) => (id === k.numbers[0] ? 'whatsapp-01' : 'whatsapp-02');

    // O lead A responde (pelo número em que foi chamado).
    expect((await k.reply(phoneOf(a.lead_id), nameOf(a.instance_id))).statusCode).toBe(200);
    const cancelled = (await k.campaignRuns(s.campaignId)).find((r) => r.id === a.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', cancel_reason: 'lead_respondeu' });
    expect((await k.campaignRuns(s.campaignId)).find((r) => r.id === b.id)).toMatchObject({
      status: 'pending',
    });
    expect(await statusOf(s.campaignId)).toBe('active'); // a campanha continua

    // Uma hora depois: o lead B recebe a etapa 2; o lead A não recebe nada; novos leads continuam entrando.
    const texts = () => k.fake.calls.filter((c) => c.url.startsWith('/message/sendText/'));
    await k.simulate({ from: 661, to: 900, step: 2 });
    const destinations = texts().map(destination);
    expect(destinations).toContain(phoneOf(b.lead_id));
    expect(destinations).not.toContain(phoneOf(a.lead_id));
    const final = await k.campaignRuns(s.campaignId);
    expect(final.length).toBeGreaterThan(runsNow.length);
    expect(final.filter((r) => r.cancel_reason === 'lead_respondeu')).toHaveLength(1);
  });

  it('telefone sem WhatsApp é ignorado com o motivo, não gasta vaga do número e a campanha segue', async () => {
    const s = await setup({
      leads: 4,
      numbers: [k.numbers[0]],
      audios: 1,
      extra: { dailyLimitPerNumber: 2 },
    });
    // O primeiro lead da fila (menor id) não tem WhatsApp (a Evolution de mentira responde "não existe" no final 9999).
    const [noWa] = s.leadIds as [number];
    await k.t.db.updateTable('leads').set({ phone: '5541999999999' }).where('id', '=', noWa).execute();
    await k.simulate({ from: 600, to: 965 });

    const runs = await k.campaignRuns(s.campaignId);
    const skipped = runs.find((r) => r.lead_id === noWa);
    expect(skipped).toMatchObject({ status: 'failed', cancel_reason: 'sem_whatsapp' });
    const lead = await k.t.db
      .selectFrom('leads')
      .select(['status', 'result'])
      .where('id', '=', noWa)
      .executeTakeFirstOrThrow();
    expect(lead).toMatchObject({ status: 'chamado', result: 'sem_whatsapp' });
    // A vaga do dia NÃO foi gasta: com limite 2, dois leads com WhatsApp ainda receberam a mensagem.
    expect(k.sends()).toHaveLength(2);
    expect(k.sends().map(destination)).not.toContain('5541999999999');
    const usage = await detail(s, at(16, 5));
    expect(usage.numbers[0]?.usedToday).toBe(2);
    const audit = await k.t.db
      .selectFrom('audit_log')
      .select(['action', 'details'])
      .where('action', '=', 'lead_ignorado_campanha')
      .where('entity_id', '=', String(s.automationId))
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({ campanha: s.campaignId, lead: noWa, motivo: 'sem_whatsapp' });
    // O quarto lead fica para o dia seguinte (o número já enviou os 2 do dia).
    expect(runs).toHaveLength(3);
  });

  it('telefone em "não contatar" não entra; se for bloqueado DEPOIS de reservado, a participação é cancelada', async () => {
    const s = await setup({ leads: 4, numbers: [k.numbers[0]], audios: 1 });
    await k.t.db
      .insertInto('blocked_phones')
      .values({ phone: s.phones[0] as string })
      .execute();
    await k.tick(at(9, 0)); // o primeiro (bloqueado) é pulado: quem é reservado é o segundo
    const reserved = (await k.campaignRuns(s.campaignId))[0];
    expect(reserved?.lead_id).toBe(s.leadIds[1]);
    // Bloqueia o reservado antes de enviar: o executor confere de novo e cancela, sem enviar.
    await k.t.db
      .insertInto('blocked_phones')
      .values({ phone: s.phones[1] as string })
      .execute();
    await k.tick(at(10, 1));
    expect(k.sends()).toHaveLength(0);
    expect((await k.campaignRuns(s.campaignId)).find((r) => r.id === reserved?.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'lead_bloqueado',
    });
    // A vaga voltou e o terceiro lead é o próximo.
    await k.simulate({ from: 602, to: 700 });
    const delivered = k.sends().map(destination);
    expect(delivered).toContain(s.phones[2]);
    expect(delivered).not.toContain(s.phones[0]);
    expect(delivered).not.toContain(s.phones[1]);
  });

  it('lead que um atendente pegou depois da reserva sai da campanha (a vaga volta)', async () => {
    const s = await setup({ leads: 3, numbers: [k.numbers[0]], audios: 1 });
    await k.tick(at(9, 0));
    const reserved = (await k.campaignRuns(s.campaignId))[0];
    await k.t.db
      .updateTable('leads')
      .set({ assigned_to: k.anaId, assigned_at: new Date() })
      .where('id', '=', reserved?.lead_id as number)
      .execute();
    await k.simulate({ from: 600, to: 700 });
    const runs = await k.campaignRuns(s.campaignId);
    expect(runs.find((r) => r.id === reserved?.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'lead_indisponivel',
    });
    expect(k.sends().map(destination)).not.toContain(s.phones[0]);
    expect(k.sends().map(destination)).toEqual([s.phones[1], s.phones[2]]);
  });
});

// ---------- 5. horário de trabalho ----------

describe('campanha: horário de trabalho (10:00 às 16:00, São Paulo)', () => {
  it('nada sai antes das 10:00 nem a partir das 16:00, mesmo com o envio vencido', async () => {
    const s = await setup({ leads: 6, numbers: [k.numbers[0]], audios: 1 });
    await k.tick(at(7, 0)); // reserva cedo; o envio é marcado para a abertura
    let run: Awaited<ReturnType<typeof k.campaignRuns>>[number] | undefined = (
      await k.campaignRuns(s.campaignId)
    )[0];
    expect(run?.status).toBe('pending');
    expect(run?.next_run_at?.getTime()).toBeGreaterThanOrEqual(at(10).getTime());
    expect(run?.next_run_at?.getTime()).toBeLessThan(at(10, 1).getTime());

    // Vencido há horas, mas antes da abertura: nada sai.
    await k.t.db
      .updateTable('automation_runs')
      .set({ next_run_at: at(6, 0) })
      .where('id', '=', run?.id as number)
      .execute();
    expect((await runAutomationCycle(k.t.db, { now: at(9, 59, 59) })).claimed).toBe(0);
    expect(k.sends()).toHaveLength(0);
    expect((await runAutomationCycle(k.t.db, { now: at(10, 0, 0) })).sent).toBe(1);

    // No fim do dia: vence às 15:59:59 e sai; vence às 16:00:00 e NÃO sai (só no dia seguinte, na abertura).
    await k.tick(at(10, 1));
    run = (await k.campaignRuns(s.campaignId)).find((r) => r.status === 'pending');
    await k.t.db
      .updateTable('automation_runs')
      .set({ next_run_at: at(15, 0) })
      .where('id', '=', run?.id as number)
      .execute();
    expect((await runAutomationCycle(k.t.db, { now: at(16, 0, 0) })).claimed).toBe(0);
    expect((await runAutomationCycle(k.t.db, { now: at(20, 0, 0) })).claimed).toBe(0);
    expect(k.sends()).toHaveLength(1);
    expect((await runAutomationCycle(k.t.db, { now: at(15, 59, 59) })).sent).toBe(1);
    expect(k.sends()).toHaveLength(2);
  });

  it('a fila também respeita a janela: fechou hoje, não reserva; abre amanhã, reserva de novo', async () => {
    const s = await setup({ leads: 6, numbers: [k.numbers[0]], audios: 1 });
    expect((await advanceCampaigns(k.t.db, { now: at(16, 0) })).reserved).toBe(0);
    expect((await advanceCampaigns(k.t.db, { now: at(22, 30) })).reserved).toBe(0);
    expect(await k.campaignRuns(s.campaignId)).toHaveLength(0);
    expect((await advanceCampaigns(k.t.db, { now: at(6, 0, 0, NEXT_DAY) })).reserved).toBe(1);
    const run = (await k.campaignRuns(s.campaignId))[0];
    expect(run?.next_run_at?.getTime()).toBeGreaterThanOrEqual(at(10, 0, 0, NEXT_DAY).getTime());
  });

  it('respeita o horário escolhido (13:00 às 14:00): tudo sai dentro dele', async () => {
    const s = await setup({
      leads: 30,
      numbers: [k.numbers[0], k.numbers[1]],
      audios: 1,
      extra: { windowStart: '13:00', windowEnd: '14:00', dailyLimitPerNumber: 4 },
    });
    await k.simulate({ from: 540, to: 1000 });
    expect(k.sends()).toHaveLength(8);
    const finished = await k.t.db
      .selectFrom('automation_step_runs as sr')
      .innerJoin('automation_runs as r', 'r.id', 'sr.automation_run_id')
      .select('sr.finished_at')
      .where('r.campaign_id', '=', s.campaignId)
      .execute();
    expect(finished).toHaveLength(8);
    for (const row of finished) {
      const t = row.finished_at?.getTime() as number;
      expect(t).toBeGreaterThanOrEqual(at(13).getTime());
      expect(t).toBeLessThan(at(14).getTime());
    }
  });

  it('os envios do dia se espalham pela janela (não saem todos no começo)', async () => {
    const s = await setup({ leads: 20, numbers: [k.numbers[0]], audios: 1 });
    await k.simulate({ from: 600, to: 965 });
    const times = (
      await k.t.db
        .selectFrom('automation_step_runs as sr')
        .innerJoin('automation_runs as r', 'r.id', 'sr.automation_run_id')
        .select('sr.finished_at')
        .where('r.campaign_id', '=', s.campaignId)
        .orderBy('sr.id')
        .execute()
    ).map((r) => (r.finished_at as Date).getTime());
    expect(times).toHaveLength(20);
    const gaps = times.slice(1).map((t, i) => (t - (times[i] as number)) / 60_000);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...times)).toBeLessThan(at(16).getTime());
    expect((Math.max(...times) - Math.min(...times)) / 3_600_000).toBeGreaterThan(4.5);
    // Nenhum horário guardado cai fora da janela.
    const pending = await k.t.db
      .selectFrom('automation_runs')
      .select('next_run_at')
      .where('status', '=', 'pending')
      .execute();
    for (const p of pending)
      expect(p.next_run_at === null || p.next_run_at.getTime() >= at(10).getTime()).toBe(true);
  });

  it('a etapa seguinte que cairia fora do horário vai para a abertura do próximo dia', async () => {
    const s = await setup({
      leads: 2,
      numbers: [k.numbers[0]],
      audios: 1,
      steps: (a) => [{ audio: a[0]?.id }, { text: 'Segunda etapa', delaySeconds: 2 * 3600 }],
    });
    await k.tick(at(9, 0));
    const run = (await k.campaignRuns(s.campaignId))[0];
    await k.t.db
      .updateTable('automation_runs')
      .set({ next_run_at: at(15, 0) })
      .where('id', '=', run?.id as number)
      .execute();
    expect((await runAutomationCycle(k.t.db, { now: at(15, 0) })).sent).toBe(1);
    // 15:00 + 2h = 17:00: fora do horário. A etapa 2 fica marcada para as 10:00 do dia seguinte.
    const after = (await k.campaignRuns(s.campaignId)).find((r) => r.id === run?.id);
    expect(after).toMatchObject({ status: 'pending', current_step: 2 });
    expect(after?.next_run_at?.toISOString()).toBe(spInstant(addDays(DAY, 1), 600).toISOString());
    expect((await runAutomationCycle(k.t.db, { now: at(17, 30) })).claimed).toBe(0);
    expect((await runAutomationCycle(k.t.db, { now: at(10, 0, 0, NEXT_DAY) })).sent).toBe(1);
    expect(k.fake.calls.filter((c) => c.url.startsWith('/message/sendText/'))).toHaveLength(1);
  });
});

// ---------- 6. pausar, retomar, encerrar ----------

describe('campanha: pausar, retomar e encerrar', () => {
  it('pausar: nenhum lead novo entra e nada é enviado; retomar segue de onde parou, sem duplicar', async () => {
    const s = await setup({ leads: 12, audios: 1 });
    await k.tick(at(10));
    const reservedBefore = await k.campaignRuns(s.campaignId);
    expect(reservedBefore).toHaveLength(2);

    const paused = await k.admin.post(
      `/api/automations/${s.automationId}/campaigns/${s.campaignId}/pause`,
      {},
    );
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json()).toMatchObject({ status: 'paused' });
    await k.simulate({ from: 601, to: 780, step: 3 });
    expect(k.sends()).toHaveLength(0);
    const during = await k.campaignRuns(s.campaignId);
    expect(during).toHaveLength(2); // nenhum lead novo
    expect(during.every((r) => r.status === 'pending')).toBe(true);
    // Pausar de novo é recusado com o motivo.
    expect(
      (await k.admin.post(`/api/automations/${s.automationId}/campaigns/${s.campaignId}/pause`, {}))
        .statusCode,
    ).toBe(409);
    // Retomar (no relógio do teste): o que venceu na pausa sai aos poucos, e cada lead recebe UMA mensagem só.
    const resumed = await resumeCampaign(k.t.db, k.adminUser, s.automationId, s.campaignId, null, at(12, 0));
    expect(resumed.status).toBe('active');
    expect(
      (await k.admin.post(`/api/automations/${s.automationId}/campaigns/${s.campaignId}/resume`, {}))
        .statusCode,
    ).toBe(409);
    // Só pode existir uma campanha viva: enquanto pausada ela também ocupa a vaga.
    await k.admin.post(`/api/automations/${s.automationId}/campaigns/${s.campaignId}/pause`, {});
    const other = await k.newList(3);
    expect((await k.startCampaign(s.automationId, other.listId, [k.numbers[0]])).statusCode).toBe(409);
    await resumeCampaign(k.t.db, k.adminUser, s.automationId, s.campaignId, null, at(12, 1));
    await k.simulate({ from: 720, to: 965 });
    const destinations = k.sends().map(destination);
    expect(new Set(destinations).size).toBe(destinations.length);
    expect(destinations.length).toBe(12);
    const actions = await k.auditActions(s.automationId);
    expect(actions.filter((a) => a === 'pausou_campanha')).toHaveLength(2);
    expect(actions.filter((a) => a === 'retomou_campanha')).toHaveLength(2);
  });

  it('ao retomar, o que venceu durante a pausa sai aos poucos (um por minuto por número), não de uma vez', async () => {
    const s = await setup({
      leads: 8,
      numbers: [k.numbers[0]],
      audios: 1,
      steps: (a) => [{ audio: a[0]?.id }, { text: 'Etapa 2', delaySeconds: 60 }],
    });
    // Cinco participações já na etapa 2, todas vencidas.
    const runs = [];
    for (const leadId of s.leadIds.slice(0, 5)) {
      const row = await k.t.db
        .insertInto('automation_runs')
        .values({
          automation_id: s.automationId,
          lead_id: leadId,
          instance_id: k.numbers[0],
          campaign_id: s.campaignId,
          slot_date: DAY,
          status: 'pending',
          current_step: 2,
          started_at: at(10),
          next_run_at: at(10, 30 + runs.length),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      runs.push(row.id);
    }
    await k.admin.post(`/api/automations/${s.automationId}/campaigns/${s.campaignId}/pause`, {});
    const T = at(13, 0);
    await resumeCampaign(k.t.db, k.adminUser, s.automationId, s.campaignId, null, T);
    const after = await k.t.db
      .selectFrom('automation_runs')
      .select(['id', 'next_run_at'])
      .where('id', 'in', runs)
      .orderBy('next_run_at')
      .execute();
    expect(after.map((r) => ((r.next_run_at as Date).getTime() - T.getTime()) / 1000)).toEqual([
      0,
      RESUME_GAP_SECONDS,
      2 * RESUME_GAP_SECONDS,
      3 * RESUME_GAP_SECONDS,
      4 * RESUME_GAP_SECONDS,
    ]);
    expect(after.map((r) => r.id)).toEqual(runs); // na ordem em que já estavam
  });

  it('encerrar: cancela o que falta (inclusive a etapa seguinte), mantém o histórico e não volta', async () => {
    const s = await setup({
      leads: 8,
      audios: 1,
      steps: (a) => [{ audio: a[0]?.id }, { text: 'Etapa 2', delaySeconds: 3600 }],
    });
    await k.simulate({ from: 600, to: 660 });
    const sentBefore = k.sends().length;
    expect(sentBefore).toBeGreaterThanOrEqual(2);
    const stepRunsBefore = await k.t.db
      .selectFrom('automation_step_runs as sr')
      .innerJoin('automation_runs as r', 'r.id', 'sr.automation_run_id')
      .select(['sr.id', 'sr.status', 'sr.message_id'])
      .where('r.campaign_id', '=', s.campaignId)
      .execute();

    const stopped = await k.admin.post(
      `/api/automations/${s.automationId}/campaigns/${s.campaignId}/stop`,
      {},
    );
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json()).toMatchObject({ status: 'stopped', endReason: 'encerrada_manualmente' });
    expect(stopped.json().endedAt).not.toBeNull();

    const runs = await k.campaignRuns(s.campaignId);
    expect(runs.filter((r) => r.status === 'pending' || r.status === 'running')).toHaveLength(0);
    const cancelled = runs.filter((r) => r.status === 'cancelled');
    expect(cancelled.length).toBeGreaterThanOrEqual(2);
    expect(cancelled.every((r) => r.cancel_reason === 'campanha_encerrada')).toBe(true);
    // O histórico do que já foi enviado fica (etapas concluídas e mensagens).
    const stepRunsAfter = await k.t.db
      .selectFrom('automation_step_runs as sr')
      .innerJoin('automation_runs as r', 'r.id', 'sr.automation_run_id')
      .select(['sr.id', 'sr.status', 'sr.message_id'])
      .where('r.campaign_id', '=', s.campaignId)
      .execute();
    expect(stepRunsAfter.filter((x) => x.status === 'completed')).toHaveLength(
      stepRunsBefore.filter((x) => x.status === 'completed').length,
    );
    expect(stepRunsAfter.filter((x) => x.status === 'completed').every((x) => x.message_id !== null)).toBe(
      true,
    );

    // Depois de encerrada: nenhum lead novo, nenhum envio, e não dá para pausar, retomar ou encerrar de novo.
    await k.simulate({ from: 661, to: 965, step: 5 });
    await k.simulate({ day: NEXT_DAY, from: 600, to: 965, step: 10 });
    expect(k.sends()).toHaveLength(sentBefore);
    expect(await k.campaignRuns(s.campaignId)).toHaveLength(runs.length);
    for (const action of ['pause', 'resume', 'stop']) {
      const r = await k.admin.post(
        `/api/automations/${s.automationId}/campaigns/${s.campaignId}/${action}`,
        {},
      );
      expect(r.statusCode, action).toBe(409);
      expect(r.json().error).toMatch(/encerrada/);
    }
    const audit = await k.t.db
      .selectFrom('audit_log')
      .select('details')
      .where('action', '=', 'encerrou_campanha')
      .where('entity_id', '=', String(s.automationId))
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({ campanha: s.campaignId, motivo: 'encerrada_manualmente' });
    // A automação pode ter outra campanha depois.
    const other = await k.newList(4);
    expect((await k.startCampaign(s.automationId, other.listId, [k.numbers[0]])).statusCode).toBe(201);
  });

  it('pausar ou arquivar a AUTOMAÇÃO também para a campanha (nada é reservado nem enviado)', async () => {
    const s = await setup({ leads: 40, audios: 1 });
    await k.tick(at(10));
    await k.admin.patch(`/api/automations/${s.automationId}/status`, { status: 'paused' });
    await k.simulate({ from: 601, to: 700, step: 3 });
    expect(k.sends()).toHaveLength(0);
    expect(await k.campaignRuns(s.campaignId)).toHaveLength(2);
    expect(await statusOf(s.campaignId)).toBe('active');
    // Retomar a campanha exige a automação ativa; ao ativar, tudo segue.
    await k.admin.post(`/api/automations/${s.automationId}/campaigns/${s.campaignId}/pause`, {});
    expect(
      (await k.admin.post(`/api/automations/${s.automationId}/campaigns/${s.campaignId}/resume`, {}))
        .statusCode,
    ).toBe(409);
    await k.admin.patch(`/api/automations/${s.automationId}/status`, { status: 'active' });
    await resumeCampaign(k.t.db, k.adminUser, s.automationId, s.campaignId, null, at(12, 0));
    await k.simulate({ from: 720, to: 780 });
    expect(k.sends().length).toBeGreaterThanOrEqual(2);

    // Arquivar a automação encerra a campanha e cancela o que estava em andamento.
    expect((await k.admin.post(`/api/automations/${s.automationId}/archive`, {})).statusCode).toBe(200);
    expect(await statusOf(s.campaignId)).toBe('stopped');
    const runs = await k.campaignRuns(s.campaignId);
    expect(runs.filter((r) => r.status === 'pending' || r.status === 'running')).toHaveLength(0);
    const sends = k.sends().length;
    await k.simulate({ from: 781, to: 965, step: 5 });
    expect(k.sends()).toHaveLength(sends);
  });

  it('lista arquivada ou excluída encerra a campanha com o motivo', async () => {
    const archived = await setup({ leads: 6, audios: 1 });
    await k.t.db
      .updateTable('lists')
      .set({ archived_at: new Date() })
      .where('id', '=', archived.listId)
      .execute();
    await k.tick(at(10));
    expect(await statusOf(archived.campaignId)).toBe('stopped');
    const one = await k.t.db
      .selectFrom('automation_campaigns')
      .select('end_reason')
      .where('id', '=', archived.campaignId)
      .executeTakeFirstOrThrow();
    expect(one.end_reason).toBe('lista_arquivada');

    const removed = await setup({ leads: 6, audios: 1 });
    await k.t.db.deleteFrom('lists').where('id', '=', removed.listId).execute();
    await k.tick(at(10, 1));
    expect(await statusOf(removed.campaignId)).toBe('stopped');
    const two = await k.t.db
      .selectFrom('automation_campaigns')
      .select('end_reason')
      .where('id', '=', removed.campaignId)
      .executeTakeFirstOrThrow();
    expect(two.end_reason).toBe('lista_removida');
    expect(k.sends()).toHaveLength(0);
  });
});

// ---------- 7. reinício, vários processos e auditoria ----------

describe('campanha: reinício, dois processos e auditoria', () => {
  it('depois de um "reinício" (conexão nova, nada em memória) a campanha continua e o limite é respeitado', async () => {
    const s = await setup({ leads: 30, extra: { dailyLimitPerNumber: 6 } });
    await k.simulate({ from: 600, to: 780 });
    const morning = k.sends().length;
    expect(morning).toBeGreaterThan(0);
    expect(morning).toBeLessThan(12);

    // "Processo novo": outra conexão com o banco. O estado da campanha e a contagem do dia estão no PostgreSQL.
    const fresh = createDb(createPool(k.t.url, 4));
    try {
      await k.simulate({ from: 781, to: 965, db: fresh });
    } finally {
      await fresh.destroy();
    }
    expect(k.sends()).toHaveLength(12); // 6 por número, nem um a mais nem a menos
    expect(k.sendsByNumber()).toEqual({ 'whatsapp-01': 6, 'whatsapp-02': 6 });
    expect(new Set(k.sends().map(destination)).size).toBe(12);
    for (const row of await perNumberPerDay(s.campaignId)) expect(row.n).toBeLessThanOrEqual(6);
  });

  it('dois processos ao mesmo tempo (ciclos em paralelo) não duplicam envio nem passam do limite', async () => {
    const s = await setup({ leads: 40, extra: { dailyLimitPerNumber: 8 } });
    const other = createDb(createPool(k.t.url, 4));
    try {
      for (let minute = 600; minute <= 965; minute++) {
        const now = spInstant(DAY, minute);
        await Promise.all([k.tick(now), k.tick(now, other), k.tick(now)]);
      }
    } finally {
      await other.destroy();
    }
    expect(k.sends()).toHaveLength(16);
    expect(k.sendsByNumber()).toEqual({ 'whatsapp-01': 8, 'whatsapp-02': 8 });
    expect(new Set(k.sends().map(destination)).size).toBe(16);
    const runs = await k.campaignRuns(s.campaignId);
    expect(new Set(runs.map((r) => r.lead_id)).size).toBe(runs.length); // nenhum lead entrou duas vezes
    for (const row of await perNumberPerDay(s.campaignId)) expect(row.n).toBeLessThanOrEqual(8);
  });

  it('o job do scheduler existente também roda as campanhas (sem um novo job, sem timer por lead)', async () => {
    const s = await setup({ leads: 3, numbers: [k.numbers[0]], audios: 1 });
    // Só o horário de trabalho decide se envia: como o relógio real pode estar fora dele, o teste conta as reservas.
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const timeouts = vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => ({ unref() {} })) as never);
    let stop = () => {};
    try {
      stop = startJobs(k.t.db, k.t.app.log);
    } finally {
      timeouts.mockRestore();
    }
    try {
      const ticks = intervals.mock.calls.filter(([, ms]) => ms === CYCLE_SECONDS * 1000);
      expect(ticks).toHaveLength(1); // o mesmo intervalo das automações: não há job novo
      const tick = ticks[0]?.[0] as () => void;
      tick();
      await vi.waitFor(async () => {
        const runs = await k.campaignRuns(s.campaignId);
        const minutes = spTime(new Date()).minutes;
        // Dentro do horário (10:00–16:00) o lead é reservado; fora dele, nada é reservado.
        expect(runs.length).toBe(minutes >= 600 && minutes < 960 ? 1 : 0);
      });
    } finally {
      stop();
      intervals.mockRestore();
    }
  });

  it('registra tudo na auditoria, sem nome nem telefone de lead', async () => {
    const s = await setup({
      leads: 6,
      numbers: [k.numbers[0]],
      audios: 1,
      extra: { dailyLimitPerNumber: 2 },
    });
    await k.simulate({ from: 600, to: 965 });
    await k.admin.post(`/api/automations/${s.automationId}/campaigns/${s.campaignId}/pause`, {});
    await resumeCampaign(k.t.db, k.adminUser, s.automationId, s.campaignId, null, at(9, 0, 0, NEXT_DAY));
    await k.admin.post(`/api/automations/${s.automationId}/campaigns/${s.campaignId}/stop`, {});

    const actions = await k.auditActions(s.automationId);
    for (const action of [
      'iniciou_campanha',
      'lead_adicionado_campanha',
      'enviou_etapa_automacao',
      'pausou_campanha',
      'retomou_campanha',
      'encerrou_campanha',
    ]) {
      expect(actions, action).toContain(action);
    }
    expect(actions.filter((a) => a === 'lead_adicionado_campanha')).toHaveLength(2);
    // O teto do dia do número (2) foi atingido: registrado na auditoria do NÚMERO, com a origem.
    expect((await k.numberLimitAudits({ campaignId: s.campaignId })).length).toBeGreaterThanOrEqual(1);
    const rows = await k.t.db
      .selectFrom('audit_log')
      .select(['action', 'details', 'user_id'])
      .where('entity', '=', 'automacao')
      .where('entity_id', '=', String(s.automationId))
      .execute();
    const sent = rows.find((r) => r.action === 'enviou_etapa_automacao');
    expect(sent?.details).toMatchObject({ campanha: s.campaignId, numero: k.numbers[0] });
    expect(sent?.details).toMatchObject({ audio: s.audios[0]?.id });
    const start = rows.find((r) => r.action === 'iniciou_campanha');
    expect(start?.user_id).toBe(k.adminUser.id);
    expect(start?.details).toMatchObject({
      lista: 'Lista de teste',
      janela: '10:00–16:00',
      limite_por_numero: 2,
    });
    const text = JSON.stringify(rows.map((r) => r.details));
    for (const phone of s.phones) expect(text).not.toContain(phone);
    for (const leadId of s.leadIds) {
      const lead = await k.t.db
        .selectFrom('leads')
        .select('name')
        .where('id', '=', leadId)
        .executeTakeFirstOrThrow();
      expect(text).not.toContain(lead.name);
    }
  });

  it('a lista de execuções filtra pela campanha e mostra número, áudio e horário', async () => {
    const s = await setup({ leads: 4, numbers: [k.numbers[0]], audios: 2 });
    await k.simulate({ from: 600, to: 700 });
    const all = (
      await k.admin.get(`/api/automations/${s.automationId}/runs?campaignId=${s.campaignId}`)
    ).json();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.every((r: { campaignId: number }) => r.campaignId === s.campaignId)).toBe(true);
    const first = all[all.length - 1];
    expect(first.instance).toMatchObject({ id: k.numbers[0] });
    expect(first.steps[0]).toMatchObject({ status: 'completed' });
    expect(first.steps[0].audio.label).toMatch(/^Áudio \d$/);
    expect(first.steps[0].finishedAt).not.toBeNull();
    const none = (
      await k.admin.get(`/api/automations/${s.automationId}/runs?campaignId=${s.campaignId + 100}`)
    ).json();
    expect(none).toEqual([]);
    expect((await k.admin.get(`/api/automations/${s.automationId}/runs?campaignId=0`)).statusCode).toBe(400);
  });
});
