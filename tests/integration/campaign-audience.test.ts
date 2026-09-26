import { Kysely, PostgresDialect, sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '../../src/server/db';
import type { Database } from '../../src/server/db/schema';
import {
  type AudienceConfig,
  campaignAudienceSummary,
  countCampaignEligibleLeads,
  getCampaignEligibleLeads,
} from '../../src/server/modules/automations/campaign-audience';
import { reserveNext } from '../../src/server/modules/automations/queue';
import type { CampaignFilters } from '../../src/shared/campaign-plan';
import { at, campaignKit } from '../campaign-kit';
import { seedList } from '../helpers';

// O público da campanha: UMA função de elegibilidade (`getCampaignEligibleLeads`) que a reserva, a contagem e a prévia usam.
// Aqui: cada filtro, as combinações, o bloqueio, a participação, o cooldown (23h59 x 24h01) e a corrida entre campanhas.

const k = campaignKit();
const NOW = at(9, 0);

interface Base {
  automationId: number;
  listId: string;
  leadIds: number[];
}

async function base(count: number, name?: string): Promise<Base> {
  const automationId = await k.makeAutomation([{ text: 'Olá!' }]);
  const list = await k.newList(count, { name });
  return { automationId, listId: list.listId, leadIds: list.leadIds };
}

const cfg = (
  b: Base,
  filters: CampaignFilters = {},
  cooldownHours = 24,
  campaignId: number | null = null,
): AudienceConfig => ({
  listId: b.listId,
  automationId: b.automationId,
  campaignId,
  filters,
  cooldownHours,
});
const eligible = (c: AudienceConfig, now = NOW) =>
  getCampaignEligibleLeads(k.t.db, c, now, { limit: 100_000 });
const patch = (ids: number[], set: Record<string, unknown>) =>
  k.t.db
    .updateTable('leads')
    .set(set as never)
    .where('id', 'in', ids)
    .execute();
/** Telefone de outro DDD (a coluna `ddd` é calculada pelo banco a partir do número). */
const moveToDdd = async (ids: number[], ddd: string) => {
  for (const [i, id] of ids.entries()) {
    await k.t.db
      .updateTable('leads')
      .set({ phone: `55${ddd}9${String(70_000_000 + id * 10 + i).padStart(8, '0')}` })
      .where('id', '=', id)
      .execute();
  }
};
const pick = (b: Base, from: number, to: number) => b.leadIds.slice(from, to);
/** Lead já chamado: o banco exige a data e o resultado do contato. */
const called = (extra: Record<string, unknown> = {}) => ({
  status: 'chamado',
  called_at: new Date(),
  result: 'enviado',
  ...extra,
});
/** Encerra as participações vivas (o banco exige a data de cancelamento). */
const cancelLive = () =>
  k.t.db
    .updateTable('automation_runs')
    .set({ status: 'cancelled', cancelled_at: new Date() })
    .where('status', '=', 'pending')
    .execute();
/** Filtro que inclui quem já foi chamado (é quem o cooldown protege). */
const WITH_CALLED: CampaignFilters = { status: ['pendente', 'chamado'] };

describe('público: base e regras fixas', () => {
  it('a lista é a base: só entram leads dela, e só os livres da fila', async () => {
    const b = await base(6);
    await k.newList(4, { name: 'Outra lista' });
    expect(await eligible(cfg(b))).toEqual(b.leadIds);
  });

  it('lead com atendente, chamado, bloqueado ou anonimizado não entra (padrão: só pendente e livre)', async () => {
    const b = await base(8);
    await patch(pick(b, 0, 1), { assigned_to: k.anaId, assigned_at: new Date(), assigned_via: 'gestor' });
    await patch(pick(b, 1, 2), called());
    await patch(pick(b, 2, 3), { status: 'bloqueado' });
    await patch(pick(b, 3, 4), { anonymized_at: new Date() });
    expect(await eligible(cfg(b))).toEqual(pick(b, 4, 8));
  });

  it('lista arquivada não tem público', async () => {
    const b = await base(4);
    await k.t.db.updateTable('lists').set({ archived_at: new Date() }).where('id', '=', b.listId).execute();
    expect(await eligible(cfg(b))).toEqual([]);
  });

  it('"Sem WhatsApp" nunca entra, nem se o filtro pedir esse resultado', async () => {
    const b = await base(5);
    await patch(pick(b, 0, 2), { result: 'sem_whatsapp' });
    expect(await eligible(cfg(b))).toEqual(pick(b, 2, 5));
    expect(await eligible(cfg(b, { result: ['sem_whatsapp'] }))).toEqual([]);
  });

  it('lista de "não contatar" (telefone bloqueado) barra o lead mesmo que ele esteja pendente', async () => {
    const b = await base(5);
    const lead = await k.t.db
      .selectFrom('leads')
      .select(['id', 'phone'])
      .where('list_id', '=', b.listId)
      .orderBy('id')
      .execute();
    await sql`INSERT INTO blocked_phones (phone, reason) VALUES (${lead[1]?.phone}, 'pediu para não receber')`.execute(
      k.t.db,
    );
    expect(await eligible(cfg(b))).toEqual(b.leadIds.filter((id) => id !== lead[1]?.id));
  });
});

describe('público: segmentação (filtros opcionais)', () => {
  it('DDD: um, vários e nenhum', async () => {
    const b = await base(9);
    await moveToDdd(pick(b, 0, 3), '11');
    await moveToDdd(pick(b, 3, 5), '21');
    // O resto continua no DDD 41 (testPhone).
    expect(await eligible(cfg(b, { ddd: ['41'] }))).toEqual(pick(b, 5, 9));
    expect(await eligible(cfg(b, { ddd: ['11'] }))).toEqual(pick(b, 0, 3));
    expect(await eligible(cfg(b, { ddd: ['11', '21'] }))).toEqual(pick(b, 0, 5));
    expect(await eligible(cfg(b, { ddd: ['85'] }))).toEqual([]);
    expect(await eligible(cfg(b))).toEqual(b.leadIds); // sem filtro: todos
  });

  it('situação: "pendente" é o padrão; "chamado" só entra se o gestor pedir (e estiver livre)', async () => {
    const b = await base(6);
    await patch(pick(b, 0, 2), called());
    await patch(
      pick(b, 2, 3),
      called({ assigned_to: k.anaId, assigned_at: new Date(), assigned_via: 'gestor' }),
    );
    expect(await eligible(cfg(b))).toEqual(pick(b, 3, 6));
    expect(await eligible(cfg(b, { status: ['chamado'] }))).toEqual(pick(b, 0, 2)); // o do atendente fica com ele
    expect(await eligible(cfg(b, { status: ['pendente', 'chamado'] }))).toEqual([
      ...pick(b, 0, 2),
      ...pick(b, 3, 6),
    ]);
  });

  it('resultado: usa os mesmos resultados do sistema; lead sem resultado não passa quando o filtro existe', async () => {
    const b = await base(6);
    await patch(pick(b, 0, 2), called({ result: 'nao_respondeu' }));
    await patch(pick(b, 2, 3), called({ result: 'interessado' }));
    await patch(pick(b, 3, 4), called({ result: 'sem_interesse' }));
    const all = { status: ['pendente' as const, 'chamado' as const] };
    expect(await eligible(cfg(b, { ...all, result: ['nao_respondeu'] }))).toEqual(pick(b, 0, 2));
    expect(await eligible(cfg(b, { ...all, result: ['nao_respondeu', 'interessado'] }))).toEqual(
      pick(b, 0, 3),
    );
    expect(await eligible(cfg(b, { ...all, result: ['fechou'] }))).toEqual([]);
  });

  it('tipo de telefone: por padrão celular (fixo fica fora); o filtro escolhe', async () => {
    const b = await base(6);
    await patch(pick(b, 0, 2), { phone_type: 'fixo' });
    await patch(pick(b, 2, 3), { phone_type: null });
    expect(await eligible(cfg(b))).toEqual(pick(b, 2, 6)); // celular e "tipo desconhecido"
    expect(await eligible(cfg(b, { phoneType: ['fixo'] }))).toEqual(pick(b, 0, 2));
    expect(await eligible(cfg(b, { phoneType: ['movel'] }))).toEqual(pick(b, 3, 6));
    expect(await eligible(cfg(b, { phoneType: ['movel', 'fixo'] }))).toEqual([
      ...pick(b, 0, 2),
      ...pick(b, 3, 6),
    ]);
  });

  it('chamado antes: nunca, já foi ou tanto faz', async () => {
    const b = await base(6);
    await patch(pick(b, 0, 3), called());
    const both = ['pendente' as const, 'chamado' as const];
    expect(await eligible(cfg(b, { status: both, calledBefore: 'never' }))).toEqual(pick(b, 3, 6));
    expect(await eligible(cfg(b, { status: both, calledBefore: 'already' }))).toEqual(pick(b, 0, 3));
    expect(await eligible(cfg(b, { status: both, calledBefore: 'any' }))).toEqual(b.leadIds);
    expect(await eligible(cfg(b, { status: both }))).toEqual(b.leadIds);
  });

  it('combinações: DDD + celular + nunca chamado + resultado juntos (todos os filtros valem ao mesmo tempo)', async () => {
    const b = await base(12);
    await moveToDdd(pick(b, 0, 6), '11');
    await patch(pick(b, 0, 2), { phone_type: 'fixo' }); // 11, fixo
    await patch(pick(b, 2, 4), called({ result: 'nao_respondeu' })); // 11, chamado
    // 4 e 5: DDD 11, celular, nunca chamados. 6 a 11: DDD 41.
    expect(await eligible(cfg(b, { ddd: ['11'], phoneType: ['movel'], calledBefore: 'never' }))).toEqual(
      pick(b, 4, 6),
    );
    expect(
      await eligible(cfg(b, { ddd: ['11'], status: ['pendente', 'chamado'], result: ['nao_respondeu'] })),
    ).toEqual(pick(b, 2, 4));
    expect(await eligible(cfg(b, { ddd: ['41'], calledBefore: 'never' }))).toEqual(pick(b, 6, 12));
    expect(await eligible(cfg(b, { ddd: ['41'], calledBefore: 'already' }))).toEqual([]);
  });

  it('lead bloqueado (status) e anonimizado nunca entram, qualquer que seja a combinação de filtros', async () => {
    const b = await base(4);
    await patch(pick(b, 0, 1), { status: 'bloqueado' });
    await patch(pick(b, 1, 2), { anonymized_at: new Date() });
    const wide: CampaignFilters = {
      status: ['pendente', 'chamado'],
      calledBefore: 'any',
      phoneType: ['movel', 'fixo'],
    };
    expect(await eligible(cfg(b, wide))).toEqual(pick(b, 2, 4));
  });
});

describe('público: participação', () => {
  it('quem já está na automação (em andamento ou concluído) não entra de novo; cancelado ou com falha, sim', async () => {
    const b = await base(6);
    const live = pick(b, 0, 1);
    const done = pick(b, 1, 2);
    const cancelled = pick(b, 2, 3);
    const failed = pick(b, 3, 4);
    const base_ = {
      automation_id: b.automationId,
      instance_id: k.numbers[0],
      status: 'pending' as const,
      current_step: 1,
      started_at: NOW,
    };
    // Participações de uma execução manual (sem campanha), para não depender do sorteio da fila.
    for (const [ids, status] of [
      [live, 'pending'],
      [done, 'completed'],
      [cancelled, 'cancelled'],
      [failed, 'failed'],
    ] as const) {
      await k.t.db
        .insertInto('automation_runs')
        .values({
          ...base_,
          lead_id: ids[0] as number,
          status,
          completed_at: status === 'completed' ? new Date() : null,
          cancelled_at: status === 'cancelled' ? new Date() : null,
        })
        .execute();
    }
    expect(await eligible(cfg(b, {}, 0))).toEqual(pick(b, 2, 6));
  });

  it('quem já entrou NESTA campanha não volta, mesmo cancelado (uma vez por campanha)', async () => {
    const b = await base(4);
    const detail = await k.startCampaignAt(at(9, 0), b.automationId, b.listId, [k.numbers[0]]);
    await k.tick(at(9, 0));
    const [run] = await k.campaignRuns(detail.id);
    expect(run).toBeDefined();
    await k.t.db
      .updateTable('automation_runs')
      .set({ status: 'cancelled', cancelled_at: new Date() })
      .where('id', '=', run?.id as number)
      .execute();
    expect(await eligible(cfg(b, {}, 0))).toContain(run?.lead_id); // fora de campanha, o cancelado poderia voltar
    expect(await eligible(cfg(b, {}, 0, detail.id))).not.toContain(run?.lead_id); // nesta campanha, não
  });
});

describe('público: cooldown de 24 horas entre campanhas', () => {
  /** Uma campanha da automação A contata os leads; devolve o instante em que o primeiro contato do 1º lead terminou. */
  async function contactedByAnother() {
    const a = await base(3);
    await k.startCampaignAt(at(9, 0), a.automationId, a.listId, [k.numbers[0]]);
    await k.simulate({ from: 600, to: 965 });
    expect(k.sends()).toHaveLength(3);
    const first = await k.t.db
      .selectFrom('automation_step_runs as sr')
      .innerJoin('automation_runs as r', 'r.id', 'sr.automation_run_id')
      .select(['r.lead_id', 'sr.finished_at'])
      .where('sr.status', '=', 'completed')
      .orderBy('sr.id')
      .executeTakeFirstOrThrow();
    // Outra automação, com a MESMA lista: participação de A não conta para B, só o cooldown.
    const otherAutomation = await k.makeAutomation([{ text: 'Segunda abordagem' }]);
    return {
      a,
      other: { ...a, automationId: otherAutomation },
      leadId: first.lead_id,
      finishedAt: first.finished_at as Date,
    };
  }

  it('23h59 depois do primeiro contato: em cooldown, não entra; 24h01: entra', async () => {
    const { other, leadId, finishedAt } = await contactedByAnother();
    const minutes = (n: number) => new Date(finishedAt.getTime() + n * 60_000);
    // Depois do primeiro contato o lead vira "Chamado": só aparece numa nova campanha se o gestor incluir "chamado".
    expect(await eligible(cfg(other), minutes(24 * 60 + 1))).toEqual([]);
    expect(await eligible(cfg(other, WITH_CALLED), minutes(60))).not.toContain(leadId);
    expect(await eligible(cfg(other, WITH_CALLED), minutes(23 * 60 + 59))).not.toContain(leadId);
    expect(await eligible(cfg(other, WITH_CALLED), minutes(24 * 60 + 1))).toContain(leadId);
    // Cooldown maior segura por mais tempo; cooldown zero não segura.
    expect(await eligible(cfg(other, WITH_CALLED, 48), minutes(24 * 60 + 1))).not.toContain(leadId);
    expect(await eligible(cfg(other, WITH_CALLED, 48), minutes(48 * 60 + 1))).toContain(leadId);
    expect(await eligible(cfg(other, WITH_CALLED, 0), minutes(1))).toContain(leadId);
  });

  it('a prévia conta os leads em cooldown à parte, e só ELES saem do público', async () => {
    const { other, finishedAt } = await contactedByAnother();
    const soon = new Date(finishedAt.getTime() + 3600_000);
    const inside = await campaignAudienceSummary(k.t.db, cfg(other, WITH_CALLED), soon);
    expect(inside).toMatchObject({ total: 3, inCooldown: 3, eligible: 0 });
    const later = new Date(finishedAt.getTime() + 25 * 3600_000 + 1800_000);
    expect(await campaignAudienceSummary(k.t.db, cfg(other, WITH_CALLED), later)).toMatchObject({
      inCooldown: 0,
      eligible: 3,
    });
    // O cooldown olha só o PRIMEIRO contato: mudar a lista ou o filtro não o escapa.
    expect(
      await campaignAudienceSummary(k.t.db, cfg(other, { ...WITH_CALLED, ddd: ['41'] }), soon),
    ).toMatchObject({
      inCooldown: 3,
      eligible: 0,
    });
  });

  it('as etapas seguintes da MESMA execução nunca são barradas pelo cooldown', async () => {
    const automationId = await k.makeAutomation([
      { text: 'Oi!' },
      { text: 'Só passando para lembrar', delaySeconds: 3600 },
    ]);
    const list = await k.newList(2);
    await k.startCampaignAt(at(9, 0), automationId, list.listId, [k.numbers[0]], { cooldownHours: 24 });
    await k.simulate({ from: 600, to: 965 });
    const texts = k.fake.calls.filter((c) => c.url.startsWith('/message/sendText/'));
    expect(texts).toHaveLength(4); // duas mensagens para cada um dos dois leads, mesmo dentro das 24h
    const other = {
      automationId: await k.makeAutomation([{ text: 'Outra' }]),
      listId: list.listId,
      leadIds: list.leadIds,
    };
    const summary = await campaignAudienceSummary(k.t.db, cfg(other, WITH_CALLED), at(16, 30));
    expect(summary.inCooldown).toBe(2); // os dois estão em cooldown para uma NOVA abordagem independente
  });

  it('quem ainda não foi contatado (esperando a vez) não está em cooldown', async () => {
    const b = await base(3);
    await k.startCampaignAt(at(9, 0), b.automationId, b.listId, [k.numbers[0]]);
    await k.tick(at(9, 0)); // reservou um lead; nada foi enviado ainda
    const other = { ...b, automationId: await k.makeAutomation([{ text: 'Outra' }]) };
    const summary = await campaignAudienceSummary(k.t.db, cfg(other), at(9, 0));
    expect(summary.inCooldown).toBe(0);
    // Mas quem está no meio de OUTRA campanha não pode ser puxado ao mesmo tempo.
    expect(summary.participated).toBe(1);
    expect(summary.eligible).toBe(2);
  });
});

describe('público: a mesma regra em todo lugar', () => {
  it('a contagem, a lista de elegíveis e a prévia concordam (e sobram os números certos por motivo)', async () => {
    const b = await base(20);
    await patch(pick(b, 0, 2), { status: 'bloqueado' });
    await patch(pick(b, 2, 3), { anonymized_at: new Date() });
    await patch(pick(b, 3, 5), called({ result: 'sem_whatsapp' }));
    await patch(pick(b, 5, 7), { phone_type: 'fixo' });
    await moveToDdd(pick(b, 7, 10), '11');
    const c = cfg(b, { ddd: ['41'] });
    const list = await eligible(c);
    expect(list).toHaveLength(await countCampaignEligibleLeads(k.t.db, c, NOW));
    const summary = await campaignAudienceSummary(k.t.db, c, NOW);
    expect(summary.eligible).toBe(list.length);
    expect(summary).toMatchObject({
      total: 20,
      blocked: 2,
      noWhatsapp: 2,
      anonymized: 1,
      participated: 0,
      inCooldown: 0,
    });
    // Elegíveis: 20 - 2 bloqueados - 1 anonimizado - 2 sem WhatsApp - 2 fixos - 3 de outro DDD = 10.
    expect(list).toEqual(pick(b, 10, 20));
    expect(summary.eligible).toBe(10);
    // E a reserva de verdade pega o primeiro dessa mesma lista.
    const detail = await k.startCampaignAt(at(9, 0), b.automationId, b.listId, [k.numbers[0]], {
      filters: { ddd: ['41'] },
    });
    expect(detail.eligibleLeads).toBe(10);
    await k.tick(at(9, 0));
    expect((await k.campaignRuns(detail.id)).map((r) => r.lead_id)).toEqual([b.leadIds[10]]);
  });

  it('a prévia via API traz os mesmos números da consulta direta', async () => {
    const b = await base(10);
    await patch(pick(b, 0, 3), { status: 'bloqueado' });
    const r = await k.admin.post(`/api/automations/${b.automationId}/campaigns/preview`, {
      listId: b.listId,
      instanceIds: [k.numbers[0]],
      filters: { ddd: ['41'] },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().audience).toMatchObject({ total: 10, eligible: 7, blocked: 3 });
    expect(r.json().eligibleLeads).toBe(7);
  });

  it('a reserva respeita os filtros: só leads do DDD escolhido são contatados', async () => {
    const b = await base(10);
    await moveToDdd(pick(b, 0, 5), '11');
    const detail = await k.startCampaignAt(at(9, 0), b.automationId, b.listId, [k.numbers[0]], {
      filters: { ddd: ['11'] },
      dailyLimitPerNumber: 20,
    });
    await k.simulate({ from: 600, to: 965 });
    expect(new Set((await k.campaignRuns(detail.id)).map((r) => r.lead_id))).toEqual(new Set(pick(b, 0, 5)));
    expect(k.sends()).toHaveLength(5);
    // Acabou o público: a campanha termina sozinha (fim natural).
    await k.tick(at(16, 10));
    const row = await k.t.db
      .selectFrom('automation_campaigns')
      .select(['status', 'end_reason'])
      .where('id', '=', detail.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('finished');
  });
});

describe('público: concorrência', () => {
  it('a mesma lista em duas campanhas de automações diferentes: nenhum lead é abordado pelas duas ao mesmo tempo', async () => {
    const a1 = await k.makeAutomation([{ text: 'Campanha um' }]);
    const a2 = await k.makeAutomation([{ text: 'Campanha dois' }]);
    const list = await k.newList(30);
    const c1 = await k.startCampaignAt(at(9, 0), a1, list.listId, [k.numbers[0]]);
    const c2 = await k.startCampaignAt(at(9, 0), a2, list.listId, [k.numbers[1]]);
    const dbs = [createDb(createPool(k.t.url, 3)), createDb(createPool(k.t.url, 3))];
    try {
      for (let round = 0; round < 12; round++) {
        const [r1, r2] = await Promise.all([
          reserveNext(dbs[0] as never, c1.id, k.numbers[0], at(9, round)),
          reserveNext(dbs[1] as never, c2.id, k.numbers[1], at(9, round)),
        ]);
        const runs = await k.t.db
          .selectFrom('automation_runs')
          .select(['lead_id', 'campaign_id'])
          .where('status', 'in', ['pending', 'running'])
          .execute();
        const leads = runs.map((r) => r.lead_id);
        expect(new Set(leads).size, `rodada ${round}`).toBe(leads.length); // nenhum lead em duas execuções vivas
        expect(
          [r1.kind, r2.kind].every((kind) => ['reserved', 'busy', 'conflict', 'no_leads'].includes(kind)),
        ).toBe(true);
        // Libera as duas participações para a próxima rodada disputar de novo.
        await cancelLive();
      }
    } finally {
      await Promise.all(dbs.map((db) => db.destroy()));
    }
  });

  it('dois processos reservando na mesma campanha: cada lead entra uma vez só (SKIP LOCKED)', async () => {
    const b = await base(24);
    const detail = await k.startCampaignAt(
      at(9, 0),
      b.automationId,
      b.listId,
      [k.numbers[0], k.numbers[1], k.numbers[2]],
      {
        dailyLimitPerNumber: 20,
      },
    );
    const dbs = [createDb(createPool(k.t.url, 3)), createDb(createPool(k.t.url, 3))];
    try {
      for (let round = 0; round < 6; round++) {
        await Promise.all(
          k.numbers.flatMap((id) => dbs.map((db) => reserveNext(db as never, detail.id, id, at(9, round)))),
        );
        await cancelLive();
      }
    } finally {
      await Promise.all(dbs.map((db) => db.destroy()));
    }
    const runs = await k.campaignRuns(detail.id);
    expect(new Set(runs.map((r) => r.lead_id)).size).toBe(runs.length); // nenhum lead duas vezes na campanha
    expect(runs.length).toBeGreaterThanOrEqual(6);
  });

  it('a reserva com trava não devolve o lead que outra transação já travou', async () => {
    const b = await base(3);
    const c = cfg(b);
    await k.t.db.transaction().execute(async (trx) => {
      const first = await getCampaignEligibleLeads(trx, c, NOW, { limit: 1, lock: true });
      expect(first).toEqual([b.leadIds[0]]);
      // Outra conexão, ao mesmo tempo: pula o travado e pega o seguinte.
      const other = await getCampaignEligibleLeads(k.t.db, c, NOW, { limit: 1, lock: true });
      expect(other).toEqual([b.leadIds[1]]);
    });
  });
});

describe('público: volume', () => {
  it('20 mil leads: a prévia sai em consultas agregadas (sem carregar leads) e rápido', async () => {
    const automationId = await k.makeAutomation([{ text: 'Olá' }]);
    const seeded = await seedList(k.t.db, { name: 'Lista grande', count: 20_000 });
    await sql`UPDATE leads SET status = 'bloqueado' WHERE list_id = ${seeded.listId} AND id % 10 = 0`.execute(
      k.t.db,
    );
    await sql`UPDATE leads SET phone_type = 'fixo' WHERE list_id = ${seeded.listId} AND id % 10 = 1`.execute(
      k.t.db,
    );
    await sql`UPDATE leads SET result = 'sem_whatsapp', status = 'chamado', called_at = now() WHERE list_id = ${seeded.listId} AND id % 10 = 2`.execute(
      k.t.db,
    );
    const config: AudienceConfig = {
      listId: seeded.listId,
      automationId,
      campaignId: null,
      filters: {},
      cooldownHours: 24,
    };

    let statements = 0;
    const spy: Db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: createPool(k.t.url, 2) }),
      log: (e) => {
        if (e.level === 'query') statements++;
      },
    });
    try {
      const started = Date.now();
      const summary = await campaignAudienceSummary(spy, config, NOW);
      const count = await countCampaignEligibleLeads(spy, config, NOW);
      const first = await getCampaignEligibleLeads(spy, config, NOW, { limit: 1, lock: true });
      const elapsed = Date.now() - started;
      expect(summary.total).toBe(20_000);
      expect(summary.eligible).toBe(count);
      expect(count).toBe(20_000 - 2000 - 2000 - 2000); // bloqueados, fixos e sem WhatsApp saem
      expect(summary.blocked).toBe(2000);
      expect(summary.noWhatsapp).toBe(2000);
      expect(first).toHaveLength(1);
      expect(statements).toBe(3); // uma consulta por pergunta: nada de N+1
      expect(elapsed).toBeLessThan(6000);
    } finally {
      await spy.destroy();
    }
  });
});
