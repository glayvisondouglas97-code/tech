import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createDb, createPool } from '../../src/server/db';
import {
  getCampaign,
  pauseCampaign,
  resumeCampaign,
  scheduleInfo,
  stopCampaign,
  updateCampaign,
} from '../../src/server/modules/automations/campaigns';
import { runAutomationCycle } from '../../src/server/modules/automations/executor';
import { advanceCampaigns } from '../../src/server/modules/automations/queue';
import { spInstant } from '../../src/server/modules/automations/window';
import type { CampaignDetail, CampaignInput } from '../../src/shared/api';
import { at, campaignKit, DAY, type StepSpec } from '../campaign-kit';

// Agenda da campanha (Fase 6): data inicial, data final, dias da semana, horário, "iniciar agora" fora do horário,
// edição e ciclo de vida, tudo em São Paulo e com o relógio injetado. O calendário de teste:
//   Seg 09/03 · TER 10/03 (DAY) · Qua 11/03 · Qui 12/03 · Sex 13/03 · Sáb 14/03 · Dom 15/03 · Seg 16/03 · Ter 17/03
// Fim de mês: Ter 31/03 · Qua 01/04.

const k = campaignKit();
const [SEG, TER, QUA, QUI, SEX, SAB, DOM, SEG2, TER2] = [
  '2026-03-09',
  '2026-03-10',
  '2026-03-11',
  '2026-03-12',
  '2026-03-13',
  '2026-03-14',
  '2026-03-15',
  '2026-03-16',
  '2026-03-17',
];
void [SEG, DOM, TER2, TER];

const n1 = () => k.numbers[0];
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

interface Setup {
  automationId: number;
  listId: string;
  leadIds: number[];
  detail: CampaignDetail;
  campaignId: number;
}

/** Automação ativa (áudio sorteado por padrão), lista de leads livres e campanha iniciada NO INSTANTE `start`. */
async function setup(o: {
  leads: number;
  numbers?: number[];
  steps?: StepSpec[];
  start?: Date;
  extra?: Partial<CampaignInput>;
}): Promise<Setup> {
  await k.uploadAudio('Áudio da campanha');
  const automationId = await k.makeAutomation(o.steps ?? [{ audio: 'random' }]);
  const list = await k.newList(o.leads);
  const detail = await k.startCampaignAt(
    o.start ?? at(9, 0),
    automationId,
    list.listId,
    o.numbers ?? [n1()],
    o.extra,
  );
  return { automationId, listId: list.listId, leadIds: list.leadIds, detail, campaignId: detail.id };
}

const runsOf = (campaignId: number) => k.campaignRuns(campaignId);
const usageOn = (date: string) => k.usageRow(n1(), date);
const rowOf = (campaignId: number) =>
  k.t.db
    .selectFrom('automation_campaigns')
    .selectAll()
    .where('id', '=', campaignId)
    .executeTakeFirstOrThrow();

/** Um dia inteiro de ticks (10:00 às 16:05). Em dia que não executa, passos maiores bastam (nada deve acontecer). */
const runDay = (day: string, step = 1) => k.simulate({ day, from: 600, to: 965, step });

async function dueRun(o: { s: Setup; leadIndex: number; nextRunAt: Date; step?: number }): Promise<number> {
  const row = await k.t.db
    .insertInto('automation_runs')
    .values({
      automation_id: o.s.automationId,
      lead_id: o.s.leadIds[o.leadIndex] as number,
      instance_id: n1(),
      campaign_id: o.s.campaignId,
      slot_date: DAY,
      status: 'pending',
      current_step: o.step ?? 1,
      started_at: new Date(o.nextRunAt.getTime() - 3_600_000),
      next_run_at: o.nextRunAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

// ---------- data inicial ----------

describe('campanha: data inicial', () => {
  it('início hoje: dentro da janela envia; antes da janela espera a abertura (10:00) e mostra isso', async () => {
    const s = await setup({ leads: 6, start: at(9, 0), extra: { dailyLimitPerNumber: 3 } });
    expect(s.detail).toMatchObject({ status: 'active', startDate: TER, endDate: null });
    // 09:00: antes do horário. A campanha está ativa, mas espera.
    expect(s.detail.schedule).toMatchObject({ state: 'waiting', today: TER });
    expect(s.detail.schedule.reason).toMatch(/janela abre às 10:00/);
    expect(iso(s.detail.schedule.nextOpening)).toBe(iso(at(10, 0)));
    await k.tick(at(9, 0));
    expect(k.sends()).toHaveLength(0); // nada sai antes das 10:00
    await k.simulate({ from: 600, to: 965 });
    expect(k.sends()).toHaveLength(3);
    expect(scheduleInfo(await rowOf(s.campaignId), at(12, 0)).state).toBe('running');
  });

  it('início futuro: a campanha fica AGENDADA, nada é reservado nem enviado antes da data, e começa nela', async () => {
    const s = await setup({ leads: 6, start: at(9, 0), extra: { startDate: QUI, dailyLimitPerNumber: 3 } });
    expect(s.detail.startDate).toBe(QUI);
    expect(s.detail.status).toBe('active'); // "Agendada" é derivada da data, não um estado novo
    expect(s.detail.schedule).toMatchObject({ state: 'scheduled' });
    expect(s.detail.schedule.reason).toBe('Agendada: começa em 12/03/2026.');
    expect(iso(s.detail.schedule.nextOpening)).toBe(iso(at(10, 0, 0, QUI)));
    // Terça e quarta inteiras: nenhum lead reservado, nenhuma mensagem, nenhuma cota gasta.
    await runDay(TER);
    await runDay(QUA);
    await k.tick(at(23, 59, 59, QUA));
    expect(await runsOf(s.campaignId)).toHaveLength(0);
    expect(k.sends()).toHaveLength(0);
    expect(await usageOn(TER)).toMatchObject({ total: 0 });
    expect(await usageOn(QUA)).toMatchObject({ total: 0 });
    // Quinta, na abertura: começa.
    await k.tick(at(10, 0, 0, QUI));
    expect((await runsOf(s.campaignId)).length).toBeGreaterThanOrEqual(1);
    await runDay(QUI);
    expect(k.sends()).toHaveLength(3);
    expect(await usageOn(QUI)).toMatchObject({ automatic: 3, total: 3 });
  });

  it('a campanha agendada já no dia da data mostra "em andamento" dentro do horário', async () => {
    const s = await setup({ leads: 3, start: at(9, 0), extra: { startDate: QUI } });
    expect(scheduleInfo(await rowOf(s.campaignId), at(11, 0, 0, QUI)).state).toBe('running');
    expect(scheduleInfo(await rowOf(s.campaignId), at(17, 0, 0, QUI)).state).toBe('waiting');
  });

  it('a data inicial e a final ficam guardadas como datas do calendário de São Paulo (sem escorregar de dia)', async () => {
    const s = await setup({ leads: 3, extra: { startDate: '2026-10-01', endDate: '2026-10-31' } });
    expect(s.detail).toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-31' });
    const raw = await sql<{
      s: string;
      e: string;
    }>`SELECT start_date::text AS s, end_date::text AS e FROM automation_campaigns WHERE id = ${s.campaignId}`.execute(
      k.t.db,
    );
    expect(raw.rows[0]).toEqual({ s: '2026-10-01', e: '2026-10-31' });
  });
});

// ---------- data final ----------

describe('campanha: data final', () => {
  it('depois da data final nenhum primeiro contato novo sai; a campanha termina, o pendente é cancelado e o histórico fica', async () => {
    const s = await setup({
      leads: 60,
      steps: [{ audio: 'random' }, { text: 'Conseguiu ouvir?', delaySeconds: 24 * 3600 }],
      extra: { endDate: QUA },
    });
    await runDay(TER); // terça inteira: 20 contatos
    await k.simulate({ day: QUA, from: 600, to: 720 }); // quarta até o meio-dia: mais alguns...
    await advanceCampaigns(k.t.db, { now: at(12, 0, 30, QUA) }); // ...e garante um primeiro contato reservado que não saiu
    const beforeEnd = await runsOf(s.campaignId);
    const reserved = beforeEnd.filter((r) => r.status === 'pending' && r.current_step === 1);
    expect(reserved).toHaveLength(1);
    const contacted = beforeEnd.filter((r) => r.current_step > 1 || r.status === 'completed');
    expect(contacted.length).toBeGreaterThan(20);

    // Quinta: passou da data final. O primeiro tick termina a campanha e cancela o primeiro contato que não saiu.
    await k.tick(at(9, 0, 0, QUI));
    const row = await rowOf(s.campaignId);
    expect(row).toMatchObject({ status: 'finished', end_reason: 'data_final' });
    expect(row.ended_at).not.toBeNull();
    const cancelled = (await runsOf(s.campaignId)).find((r) => r.id === reserved[0]?.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', cancel_reason: 'data_final' });
    // Dias seguintes: nenhum lead novo entra e nenhum primeiro contato sai...
    const sentAudios = () => k.sends().filter((c) => c.url.includes('sendWhatsAppAudio')).length;
    const audiosAtEnd = sentAudios();
    await runDay(QUI);
    await runDay(SEX);
    expect(sentAudios()).toBe(audiosAtEnd);
    expect((await runsOf(s.campaignId)).length).toBe(beforeEnd.length);
    // ...mas quem já recebeu o primeiro contato recebe as etapas seguintes (acompanhamento) até o fim, e nada é apagado.
    const finalRuns = await runsOf(s.campaignId);
    expect(finalRuns.filter((r) => r.status === 'pending' || r.status === 'running')).toHaveLength(0);
    expect(finalRuns.filter((r) => r.status === 'completed')).toHaveLength(contacted.length);
    expect(k.fake.calls.filter((c) => c.url.startsWith('/message/sendText/'))).toHaveLength(contacted.length);
    const messages = await k.t.db
      .selectFrom('wa_messages')
      .select('id')
      .where('from_me', '=', true)
      .execute();
    expect(messages.length).toBeGreaterThanOrEqual(contacted.length * 2);
  });

  it('a data final vale INCLUSIVE: no último dia ainda envia', async () => {
    const s = await setup({ leads: 6, extra: { endDate: TER, dailyLimitPerNumber: 3 } });
    await runDay(TER);
    expect(k.sends()).toHaveLength(3);
    expect((await rowOf(s.campaignId)).status).toBe('active'); // só termina no dia seguinte, no primeiro ciclo
    await k.tick(at(9, 0, 0, QUA));
    expect((await rowOf(s.campaignId)).status).toBe('finished');
  });

  it('sem data final a campanha segue dia após dia', async () => {
    const s = await setup({ leads: 30, extra: { dailyLimitPerNumber: 2 } });
    for (const day of [TER, QUA, QUI]) await runDay(day);
    expect(k.sends()).toHaveLength(6);
    expect(await usageOn(TER)).toMatchObject({ total: 2 });
    expect(await usageOn(QUI)).toMatchObject({ total: 2 });
    expect((await rowOf(s.campaignId)).status).toBe('active');
    expect((await rowOf(s.campaignId)).end_date).toBeNull();
  });

  it('a data final do passado é recusada (a campanha terminaria no primeiro ciclo)', async () => {
    await k.uploadAudio('A');
    const automationId = await k.makeAutomation([{ audio: 'random' }]);
    const list = await k.newList(3);
    await expect(
      k.startCampaignAt(at(9, 0), automationId, list.listId, [n1()], { endDate: '2026-03-09' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ---------- dias da semana ----------

describe('campanha: dias da semana (padrão segunda a sexta)', () => {
  it('sexta e segunda executam; sábado e domingo não (mesmo com cota livre e dentro do horário)', async () => {
    const s = await setup({
      leads: 30,
      start: at(9, 0, 0, SEX),
      extra: { startDate: SEX, daysOfWeek: undefined, dailyLimitPerNumber: 3 },
    });
    expect(s.detail.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    await runDay(SEX);
    await runDay(SAB, 20);
    await runDay(DOM, 20);
    await runDay(SEG2);
    expect(await usageOn(SEX)).toMatchObject({ automatic: 3, total: 3 });
    expect(await usageOn(SAB)).toMatchObject({ total: 0 });
    expect(await usageOn(DOM)).toMatchObject({ total: 0 });
    expect(await usageOn(SEG2)).toMatchObject({ automatic: 3, total: 3 });
    expect(k.sends()).toHaveLength(6);
  });

  it('nos dias não permitidos nenhum lead novo é reservado', async () => {
    const s = await setup({
      leads: 6,
      start: at(9, 0, 0, SAB),
      extra: { startDate: SAB, daysOfWeek: [1, 2, 3, 4, 5] },
    });
    for (const minute of [0, 300, 590, 600, 700, 959]) {
      expect((await advanceCampaigns(k.t.db, { now: spInstant(SAB, minute) })).reserved).toBe(0);
    }
    expect(await runsOf(s.campaignId)).toHaveLength(0);
    expect((await advanceCampaigns(k.t.db, { now: at(9, 0, 0, SEG2) })).reserved).toBe(1);
  });

  it('só sábado e domingo: o inverso', async () => {
    await setup({
      leads: 30,
      start: at(9, 0, 0, SEX),
      extra: { startDate: SEX, daysOfWeek: [6, 7], dailyLimitPerNumber: 2 },
    });
    await runDay(SEX, 20);
    await runDay(SAB);
    await runDay(DOM);
    await runDay(SEG2, 20);
    expect(await usageOn(SEX)).toMatchObject({ total: 0 });
    expect(await usageOn(SAB)).toMatchObject({ total: 2 });
    expect(await usageOn(DOM)).toMatchObject({ total: 2 });
    expect(await usageOn(SEG2)).toMatchObject({ total: 0 });
  });

  it('o dia da semana é o de São Paulo: terça 23:30 (SP) é quarta em UTC e NÃO conta como quarta', async () => {
    const s = await setup({ leads: 6, start: at(9, 0), extra: { startDate: QUA, daysOfWeek: [3] } });
    const tuesdayNight = new Date('2026-03-11T02:30:00Z'); // terça 23:30 em São Paulo, mas já quarta em UTC
    expect((await advanceCampaigns(k.t.db, { now: tuesdayNight })).reserved).toBe(0);
    expect((await runAutomationCycle(k.t.db, { now: tuesdayNight })).claimed).toBe(0);
    expect(await runsOf(s.campaignId)).toHaveLength(0);
    // Quarta 10:00 em São Paulo (13:00Z): agora sim.
    expect((await advanceCampaigns(k.t.db, { now: new Date('2026-03-11T13:00:00Z') })).reserved).toBe(1);
  });

  it('virada do mês: 31/03 e 01/04 executam, cada dia com a sua própria cota', async () => {
    await setup({
      leads: 30,
      start: at(9, 0, 0, '2026-03-31'),
      extra: { startDate: '2026-03-31', dailyLimitPerNumber: 3 },
    });
    await runDay('2026-03-31');
    await runDay('2026-04-01');
    expect(await usageOn('2026-03-31')).toMatchObject({ automatic: 3, total: 3 });
    expect(await usageOn('2026-04-01')).toMatchObject({ automatic: 3, total: 3 });
    expect(k.sends()).toHaveLength(6);
  });
});

// ---------- horário ----------

describe('campanha: horário de trabalho', () => {
  it('10:00 permitido, 15:59 permitido, 16:00 não (o executor não pega envio vencido fora do horário)', async () => {
    const s = await setup({ leads: 6 });
    const early = await dueRun({ s, leadIndex: 0, nextRunAt: at(9, 0) });
    expect((await runAutomationCycle(k.t.db, { now: at(9, 59, 59) })).claimed).toBe(0);
    expect((await runAutomationCycle(k.t.db, { now: at(10, 0, 0) })).sent).toBe(1);
    expect((await runsOf(s.campaignId)).find((r) => r.id === early)?.status).toBe('completed');
    await dueRun({ s, leadIndex: 1, nextRunAt: at(15, 0) });
    expect((await runAutomationCycle(k.t.db, { now: at(16, 0, 0) })).claimed).toBe(0);
    expect((await runAutomationCycle(k.t.db, { now: at(15, 59, 59) })).sent).toBe(1);
  });

  it('horário escolhido pelo gestor (13:00 às 14:30)', async () => {
    await setup({ leads: 30, extra: { windowStart: '13:00', windowEnd: '14:30', dailyLimitPerNumber: 20 } });
    await k.simulate({ from: 540, to: 1000 });
    const finished = await k.t.db.selectFrom('automation_step_runs').select('finished_at').execute();
    expect(finished.length).toBeGreaterThan(3);
    for (const row of finished) {
      const time = (row.finished_at as Date).getTime();
      expect(time).toBeGreaterThanOrEqual(at(13, 0).getTime());
      expect(time).toBeLessThan(at(14, 30).getTime());
    }
  });

  it('a etapa seguinte que cairia num dia não permitido vai para a próxima janela válida (sexta → segunda)', async () => {
    const s = await setup({
      leads: 4,
      start: at(9, 0, 0, SEX),
      steps: [{ audio: 'random' }, { text: 'Acompanhamento', delaySeconds: 3600 }],
      extra: { startDate: SEX, daysOfWeek: undefined },
    });
    const runId = await dueRun({ s, leadIndex: 0, nextRunAt: at(15, 30, 0, SEX) });
    expect((await runAutomationCycle(k.t.db, { now: at(15, 30, 0, SEX) })).sent).toBe(1);
    // 15:30 + 1h = 16:30 (fora do horário) numa sexta: a segunda etapa espera a segunda-feira às 10:00.
    const run = (await runsOf(s.campaignId)).find((r) => r.id === runId);
    expect(run).toMatchObject({ status: 'pending', current_step: 2 });
    expect(iso(run?.next_run_at)).toBe(iso(at(10, 0, 0, SEG2)));
    // Sábado, domingo e segunda antes das 10:00: nada. Segunda 10:00: sai.
    for (const day of [SAB, DOM])
      expect((await runAutomationCycle(k.t.db, { now: at(11, 0, 0, day) })).claimed).toBe(0);
    expect((await runAutomationCycle(k.t.db, { now: at(9, 59, 59, SEG2) })).claimed).toBe(0);
    expect((await runAutomationCycle(k.t.db, { now: at(10, 0, 0, SEG2) })).sent).toBe(1);
    expect(k.fake.calls.filter((c) => c.url.startsWith('/message/sendText/'))).toHaveLength(1);
  });

  it('"Iniciar agora" fora do horário NÃO envia: espera a próxima janela válida (sexta 18:30 → segunda 10:00)', async () => {
    const s = await setup({
      leads: 6,
      start: at(18, 30, 0, SEX),
      extra: { startDate: SEX, daysOfWeek: undefined, dailyLimitPerNumber: 3 },
    });
    expect(s.detail.schedule.state).toBe('waiting');
    expect(s.detail.schedule.reason).toMatch(/fechou às 16:00/);
    expect(iso(s.detail.schedule.nextOpening)).toBe(iso(at(10, 0, 0, SEG2))); // amanhã é sábado: pula para segunda
    for (const [day, minute] of [
      [SEX, 1120],
      [SEX, 1400],
      [SAB, 700],
      [DOM, 700],
    ] as const) {
      await k.tick(spInstant(day, minute));
    }
    expect(await runsOf(s.campaignId)).toHaveLength(0);
    expect(k.sends()).toHaveLength(0);
    await runDay(SEG2);
    expect(k.sends()).toHaveLength(3);
    expect(await usageOn(SEG2)).toMatchObject({ automatic: 3 });
  });

  it('"Iniciar agora" numa terça às 18:30 (fim do horário): próxima execução amanhã às 10:00', async () => {
    const s = await setup({ leads: 3, start: at(18, 30), extra: { daysOfWeek: undefined } });
    expect(iso(s.detail.schedule.nextOpening)).toBe(iso(at(10, 0, 0, QUA)));
    expect(s.detail.schedule.today).toBe(TER);
  });
});

// ---------- o executor confere a agenda também na hora de enviar ----------

describe('campanha: o executor também confere a agenda na hora de enviar', () => {
  it('participação já vencida num dia não permitido não sai; sai na próxima segunda, dentro do horário', async () => {
    const s = await setup({
      leads: 3,
      start: at(9, 0, 0, SEX),
      extra: { startDate: SEX, daysOfWeek: undefined },
    });
    await dueRun({ s, leadIndex: 0, nextRunAt: at(10, 0, 0, SAB) });
    expect((await runAutomationCycle(k.t.db, { now: at(11, 0, 0, SAB) })).claimed).toBe(0);
    expect((await runAutomationCycle(k.t.db, { now: at(12, 0, 0, DOM) })).claimed).toBe(0);
    expect(k.sends()).toHaveLength(0);
    expect(await usageOn(SAB)).toMatchObject({ total: 0 });
    expect(await usageOn(DOM)).toMatchObject({ total: 0 });
    expect((await runAutomationCycle(k.t.db, { now: at(9, 59, 0, SEG2) })).claimed).toBe(0);
    expect((await runAutomationCycle(k.t.db, { now: at(10, 0, 0, SEG2) })).sent).toBe(1);
    expect(await usageOn(SEG2)).toMatchObject({ automatic: 1, total: 1 });
  });

  it('participação vencida antes da data inicial não sai; sai na data, dentro do horário', async () => {
    const s = await setup({ leads: 3, start: at(9, 0), extra: { startDate: QUI } });
    await dueRun({ s, leadIndex: 0, nextRunAt: at(10, 0, 0, QUA) });
    expect((await runAutomationCycle(k.t.db, { now: at(11, 0, 0, QUA) })).claimed).toBe(0);
    expect(k.sends()).toHaveLength(0);
    expect(await usageOn(QUA)).toMatchObject({ total: 0 });
    expect((await runAutomationCycle(k.t.db, { now: at(10, 0, 0, QUI) })).sent).toBe(1);
    expect(await usageOn(QUI)).toMatchObject({ automatic: 1, total: 1 });
  });

  it('depois da data final o primeiro contato que já estava vencido não sai (é cancelado com o motivo)', async () => {
    const s = await setup({ leads: 3, start: at(9, 0), extra: { endDate: QUA } });
    const runId = await dueRun({ s, leadIndex: 0, nextRunAt: at(10, 0, 0, QUA) });
    expect((await runAutomationCycle(k.t.db, { now: at(11, 0, 0, QUI) })).sent).toBe(0);
    await advanceCampaigns(k.t.db, { now: at(11, 0, 1, QUI) });
    expect(k.sends()).toHaveLength(0);
    expect((await runsOf(s.campaignId)).find((r) => r.id === runId)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'data_final',
    });
  });
});

// ---------- editar, pausar, retomar, encerrar ----------

describe('campanha: editar e ciclo de vida', () => {
  it('editar vale para os próximos leads: horário, dias, cooldown, filtros, números e limite', async () => {
    const s = await setup({ leads: 20, extra: { dailyLimitPerNumber: 10 } });
    const edited = await updateCampaign(
      k.t.db,
      k.adminUser,
      s.automationId,
      s.campaignId,
      {
        windowStart: '11:00',
        windowEnd: '15:00',
        daysOfWeek: [2, 3],
        cooldownHours: 48,
        endDate: '2026-04-30',
        filters: { ddd: ['41'] },
        dailyLimitPerNumber: 6,
        instanceIds: [k.numbers[0], k.numbers[1]],
      },
      null,
      at(9, 0),
    );
    expect(edited).toMatchObject({
      windowStart: '11:00',
      windowEnd: '15:00',
      daysOfWeek: [2, 3],
      cooldownHours: 48,
      endDate: '2026-04-30',
      filters: { ddd: ['41'] },
      dailyLimitPerNumber: 6,
      instanceIds: [k.numbers[0], k.numbers[1]],
    });
    // Vale já no próximo ciclo: às 10:30 (antes do novo horário) nada sai.
    await k.tick(at(10, 30));
    expect(k.sends()).toHaveLength(0);
    const audit = await k.t.db
      .selectFrom('audit_log')
      .select('details')
      .where('action', '=', 'alterou_campanha')
      .execute();
    expect(audit.some((a) => (a.details as { campanha?: number }).campanha === s.campaignId)).toBe(true);
  });

  it('a lista e a data inicial só mudam antes de qualquer lead entrar; depois, 409', async () => {
    const s = await setup({ leads: 6 });
    const other = await k.newList(3, { name: 'Outra lista' });
    await updateCampaign(
      k.t.db,
      k.adminUser,
      s.automationId,
      s.campaignId,
      { listId: other.listId },
      null,
      at(9, 0),
    );
    expect((await getCampaign(k.t.db, s.automationId, s.campaignId, at(9, 0))).list?.id).toBe(other.listId);
    await k.tick(at(10, 0)); // entra o primeiro lead
    expect((await runsOf(s.campaignId)).length).toBeGreaterThan(0);
    await expect(
      updateCampaign(
        k.t.db,
        k.adminUser,
        s.automationId,
        s.campaignId,
        { listId: s.listId },
        null,
        at(10, 1),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      updateCampaign(k.t.db, k.adminUser, s.automationId, s.campaignId, { startDate: QUI }, null, at(10, 1)),
    ).rejects.toMatchObject({ statusCode: 409 });
    // Os outros campos continuam editáveis.
    await expect(
      updateCampaign(
        k.t.db,
        k.adminUser,
        s.automationId,
        s.campaignId,
        { cooldownHours: 12 },
        null,
        at(10, 1),
      ),
    ).resolves.toMatchObject({ cooldownHours: 12 });
  });

  it('campanha encerrada não se edita; datas incoerentes e data final no passado são recusadas', async () => {
    const s = await setup({ leads: 6 });
    await expect(
      updateCampaign(
        k.t.db,
        k.adminUser,
        s.automationId,
        s.campaignId,
        { endDate: '2026-03-01' },
        null,
        at(9, 0),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      updateCampaign(
        k.t.db,
        k.adminUser,
        s.automationId,
        s.campaignId,
        { startDate: QUI, endDate: QUA },
        null,
        at(9, 0),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await stopCampaign(k.t.db, k.adminUser, s.automationId, s.campaignId, null);
    await expect(
      updateCampaign(k.t.db, k.adminUser, s.automationId, s.campaignId, { cooldownHours: 1 }, null, at(9, 0)),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('a API de edição: só quem gerencia automações; corpo validado; 404 para campanha de outra automação', async () => {
    const s = await setup({ leads: 6 });
    const url = `/api/automations/${s.automationId}/campaigns/${s.campaignId}`;
    expect((await k.ana.patch(url, { cooldownHours: 1 })).statusCode).toBe(403);
    expect((await k.admin.patch(url, {})).statusCode).toBe(400);
    expect((await k.admin.patch(url, { daysOfWeek: [] })).statusCode).toBe(400);
    expect((await k.admin.patch(url, { windowStart: '17:00', windowEnd: '09:00' })).statusCode).toBe(400);
    expect((await k.admin.patch(url, { cooldownHours: 6 })).json()).toMatchObject({ cooldownHours: 6 });
    expect(
      (
        await k.admin.patch(`/api/automations/${s.automationId + 99}/campaigns/${s.campaignId}`, {
          cooldownHours: 1,
        })
      ).statusCode,
    ).toBe(404);
    expect((await k.admin.patch(`${url}9`, { cooldownHours: 1 })).statusCode).toBe(404);
  });

  it('pausa uma campanha AGENDADA: nada entra; retoma; encerra (cancela o que houver e não volta)', async () => {
    const s = await setup({ leads: 12, start: at(9, 0), extra: { startDate: QUA, dailyLimitPerNumber: 4 } });
    expect(s.detail.schedule.state).toBe('scheduled');
    const paused = await pauseCampaign(k.t.db, k.adminUser, s.automationId, s.campaignId, null);
    expect(paused).toMatchObject({ status: 'paused' });
    expect(paused.schedule.reason).toMatch(/pausada/i);
    await runDay(QUA);
    expect(await runsOf(s.campaignId)).toHaveLength(0);
    // Retoma na quarta às 09:00: segue de onde parou, sem duplicar.
    const resumed = await resumeCampaign(
      k.t.db,
      k.adminUser,
      s.automationId,
      s.campaignId,
      null,
      at(9, 0, 0, QUA),
    );
    expect(resumed.status).toBe('active');
    await runDay(QUA);
    expect(k.sends()).toHaveLength(4);
    const destinations = k.sends().map((c) => String((c.body as { number: string }).number));
    expect(new Set(destinations).size).toBe(4);
    const stopped = await stopCampaign(k.t.db, k.adminUser, s.automationId, s.campaignId, null);
    expect(stopped).toMatchObject({ status: 'stopped', endReason: 'encerrada_manualmente' });
    expect(stopped.schedule.state).toBe('ended');
    await runDay(QUI);
    expect(k.sends()).toHaveLength(4); // encerrada: nada mais
    await expect(
      resumeCampaign(k.t.db, k.adminUser, s.automationId, s.campaignId, null),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('pausada: nenhum lead novo, nenhum primeiro contato, a agenda e as participações continuam gravadas', async () => {
    const s = await setup({ leads: 12, extra: { dailyLimitPerNumber: 5 } });
    await k.tick(at(10, 0));
    const reservedBefore = await runsOf(s.campaignId);
    expect(reservedBefore).toHaveLength(1);
    await pauseCampaign(k.t.db, k.adminUser, s.automationId, s.campaignId, null);
    await k.simulate({ from: 601, to: 965, step: 3 });
    const during = await runsOf(s.campaignId);
    expect(during).toHaveLength(1); // nenhum lead novo
    expect(k.sends()).toHaveLength(0); // nenhum primeiro contato
    expect(iso(during[0]?.next_run_at)).toBe(iso(reservedBefore[0]?.next_run_at)); // a agenda continua gravada
    expect((await usageOn(DAY)).total).toBe(0); // e a cota não foi gasta
  });
});

// ---------- reinício ----------

describe('campanha: reinício', () => {
  it('uma conexão nova ("processo novo") continua a mesma agenda, sem duplicar e sem passar do limite', async () => {
    const s = await setup({ leads: 30, extra: { dailyLimitPerNumber: 6 } });
    await k.simulate({ from: 600, to: 780 });
    const morning = k.sends().length;
    expect(morning).toBeGreaterThan(0);
    const fresh = createDb(createPool(k.t.url, 4));
    try {
      await k.simulate({ from: 781, to: 965, db: fresh });
    } finally {
      await fresh.destroy();
    }
    expect(k.sends()).toHaveLength(6);
    expect(new Set(k.sends().map((c) => String((c.body as { number: string }).number))).size).toBe(6);
    expect(await usageOn(DAY)).toMatchObject({ automatic: 6, total: 6 });
    const row = await rowOf(s.campaignId);
    expect(row).toMatchObject({ status: 'active' });
  });
});
