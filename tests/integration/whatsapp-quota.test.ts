import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '../../src/server/db';
import { getCampaign, previewCampaign } from '../../src/server/modules/automations/campaigns';
import { runAutomationCycle } from '../../src/server/modules/automations/executor';
import { advanceCampaigns, reserveNext } from '../../src/server/modules/automations/queue';
import {
  claimContactQuota,
  confirmContactQuota,
  instanceUsage,
  quotaDate,
  releaseContactQuota,
} from '../../src/server/modules/whatsapp/quota';
import type { InstanceInfo } from '../../src/shared/conversations';
import { at, campaignKit, DAY, NEXT_DAY } from '../campaign-kit';

// A cota diária de contatos por número (20, manual + automático, dia de São Paulo) contra o PostgreSQL de testes.
// Aqui se prova: o banco impede o 21º, a vaga é atômica (workers, processos, manual + automático), reserva não é uso,
// o dia novo recomeça sozinho, e o botão Chamar e as campanhas usam a MESMA regra.

const k = campaignKit();

const today = () => quotaDate(new Date());
const chamar = (leadId: number, instanceId: number, sendAudio = true) =>
  k.ana.post(`/api/leads/${leadId}/conversation`, { instanceId, sendAudio });
const LIMIT_MESSAGE = 'Este número já atingiu o limite de 20 contatos hoje.';
const audioBody = (call: { body: unknown }) => (call.body as { audio: string }).audio;

/** Abre várias conexões novas com o banco: cada uma faz o papel de um processo/worker diferente. */
async function workers(n: number): Promise<Db[]> {
  return Array.from({ length: n }, () => createDb(createPool(k.t.url, 6)));
}
const closeAll = (dbs: Db[]) => Promise.all(dbs.map((d) => d.destroy()));

/** Uma participação de campanha já vencida, para o executor pegar (reserva feita "ontem", por exemplo). */
async function dueRun(o: {
  automationId: number;
  campaignId: number;
  leadId: number;
  instanceId: number;
  nextRunAt: Date;
  slotDate?: string;
}): Promise<number> {
  const row = await k.t.db
    .insertInto('automation_runs')
    .values({
      automation_id: o.automationId,
      lead_id: o.leadId,
      instance_id: o.instanceId,
      campaign_id: o.campaignId,
      slot_date: o.slotDate ?? DAY,
      status: 'pending',
      current_step: 1,
      started_at: new Date(o.nextRunAt.getTime() - 3_600_000),
      next_run_at: o.nextRunAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function campaignWith(o: {
  leads: number;
  numbers: number[];
  extra?: Record<string, unknown>;
  audio?: boolean;
}) {
  if (o.audio !== false) await k.uploadAudio('Áudio da campanha');
  const automationId = await k.makeAutomation([{ audio: 'random' }]);
  const list = await k.newList(o.leads);
  const started = await k.startCampaign(automationId, list.listId, o.numbers, o.extra);
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  return { automationId, ...list, campaignId: started.body.id };
}

// ---------- o banco ----------

describe('cota diária: a tabela e as travas do banco', () => {
  const n1 = () => k.numbers[0];

  it('uma linha por número e por dia (UNIQUE): repetir é recusado; dia diferente é outra linha', async () => {
    await k.seedUsage(n1(), DAY, { manual: 1 });
    await expect(
      sql`INSERT INTO wa_instance_daily_usage (instance_id, usage_date) VALUES (${n1()}, ${DAY}::date)`.execute(
        k.t.db,
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await sql`INSERT INTO wa_instance_daily_usage (instance_id, usage_date) VALUES (${n1()}, ${NEXT_DAY}::date)`.execute(
      k.t.db,
    );
    const rows = await k.t.db
      .selectFrom('wa_instance_daily_usage')
      .select('id')
      .where('instance_id', '=', n1())
      .execute();
    expect(rows).toHaveLength(2);
  });

  it('o próprio banco recusa o 21º contato do dia, e total diferente da soma, e números negativos', async () => {
    const insert = (manual: number, automatic: number, uncertain: number, total: number) =>
      sql`INSERT INTO wa_instance_daily_usage (instance_id, usage_date, manual_contacts, automatic_contacts, uncertain_contacts, total_contacts)
          VALUES (${n1()}, ${DAY}::date, ${manual}, ${automatic}, ${uncertain}, ${total})`.execute(k.t.db);
    await expect(insert(10, 11, 0, 21)).rejects.toMatchObject({ code: '23514' }); // 21 contatos
    await expect(insert(20, 20, 0, 40)).rejects.toMatchObject({ code: '23514' }); // 20 manuais + 20 automáticos
    await expect(insert(5, 5, 0, 20)).rejects.toMatchObject({ code: '23514' }); // total que não bate
    await expect(insert(-1, 1, 0, 0)).rejects.toMatchObject({ code: '23514' }); // negativo
    await expect(insert(7, 13, 0, 20)).resolves.toBeDefined(); // 7 manuais + 13 automáticos = 20: aceito
  });

  it('atualizar para passar de 20 também é recusado (o banco é a última trava)', async () => {
    await k.seedUsage(n1(), DAY, { manual: 20 });
    await expect(
      sql`UPDATE wa_instance_daily_usage SET automatic_contacts = 1, total_contacts = 21 WHERE instance_id = ${n1()}`.execute(
        k.t.db,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ manual: 20, total: 20 });
  });

  it('excluir o número apaga o uso dele (não fica linha órfã)', async () => {
    await k.hook('connection.update', { state: 'open', wuid: '5511955555555@s.whatsapp.net' }, 'whatsapp-77');
    const extra = await k.t.db
      .selectFrom('wa_instances')
      .select('id')
      .where('name', '=', 'whatsapp-77')
      .executeTakeFirstOrThrow();
    await k.seedUsage(extra.id, DAY, { manual: 3 });
    await k.t.db.deleteFrom('wa_instances').where('id', '=', extra.id).execute();
    expect(await k.usageRow(extra.id, DAY)).toMatchObject({ total: 0 });
    const left = await k.t.db
      .selectFrom('wa_instance_daily_usage')
      .select('id')
      .where('instance_id', '=', extra.id)
      .execute();
    expect(left).toEqual([]);
  });
});

// ---------- a vaga: segurar, confirmar, devolver ----------

describe('cota diária: segurar, confirmar e devolver a vaga', () => {
  const n1 = () => k.numbers[0];

  it('a vaga segurada fica INCERTA; confirmada vira manual ou automático; o total só cresce uma vez', async () => {
    const a = await claimContactQuota(k.t.db, n1(), DAY);
    expect(a).toEqual({ instanceId: n1(), date: DAY });
    expect(await k.usageRow(n1(), DAY)).toEqual({ manual: 0, automatic: 0, uncertain: 1, total: 1 });
    await confirmContactQuota(k.t.db, a as NonNullable<typeof a>, 'manual');
    expect(await k.usageRow(n1(), DAY)).toEqual({ manual: 1, automatic: 0, uncertain: 0, total: 1 });
    const b = await claimContactQuota(k.t.db, n1(), DAY);
    await confirmContactQuota(k.t.db, b as NonNullable<typeof b>, 'automatic');
    expect(await k.usageRow(n1(), DAY)).toEqual({ manual: 1, automatic: 1, uncertain: 0, total: 2 });
    // Confirmar de novo não faz nada (não há mais vaga incerta): nunca conta duas vezes.
    expect(await confirmContactQuota(k.t.db, b as NonNullable<typeof b>, 'automatic')).toBeNull();
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ total: 2 });
  });

  it('devolver a vaga (mensagem sabidamente não saiu) libera; devolver de novo não passa do zero', async () => {
    const a = (await claimContactQuota(k.t.db, n1(), DAY)) as NonNullable<
      Awaited<ReturnType<typeof claimContactQuota>>
    >;
    await releaseContactQuota(k.t.db, a);
    expect(await k.usageRow(n1(), DAY)).toEqual({ manual: 0, automatic: 0, uncertain: 0, total: 0 });
    await releaseContactQuota(k.t.db, a);
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ total: 0 });
  });

  it('20 vagas: manual 7 + automático 13 = 20/20 e a 21ª é recusada', async () => {
    for (let i = 0; i < 20; i++) {
      const claim = await claimContactQuota(k.t.db, n1(), DAY);
      expect(claim, `vaga ${i + 1}`).not.toBeNull();
      await confirmContactQuota(k.t.db, claim as NonNullable<typeof claim>, i < 7 ? 'manual' : 'automatic');
    }
    expect(await k.usageRow(n1(), DAY)).toEqual({ manual: 7, automatic: 13, uncertain: 0, total: 20 });
    expect(await claimContactQuota(k.t.db, n1(), DAY)).toBeNull();
    expect(await claimContactQuota(k.t.db, n1(), DAY)).toBeNull();
    const u = (await instanceUsage(k.t.db, [n1()], DAY)).get(n1());
    expect(u).toMatchObject({
      manual: 7,
      automatic: 13,
      uncertain: 0,
      total: 20,
      remaining: 0,
      limitReached: true,
    });
  });

  it('a vaga incerta também ocupa a cota (nunca se libera uma vaga que pode ter sido gasta)', async () => {
    await k.seedUsage(n1(), DAY, { manual: 10, automatic: 9, uncertain: 1 }); // 20/20, um deles incerto
    expect(await claimContactQuota(k.t.db, n1(), DAY)).toBeNull();
  });

  it('um teto menor (campanha com limite 5) vale para o total, manual incluído', async () => {
    await k.seedUsage(n1(), DAY, { manual: 4 });
    expect(await claimContactQuota(k.t.db, n1(), DAY, 5)).not.toBeNull();
    expect(await claimContactQuota(k.t.db, n1(), DAY, 5)).toBeNull();
    // Com o teto de 20 ainda cabem contatos: o teto menor é só da campanha.
    expect(await claimContactQuota(k.t.db, n1(), DAY)).not.toBeNull();
  });

  it('número sem nenhuma linha no dia: 0/20 (e cada dia é independente)', async () => {
    const u = (await instanceUsage(k.t.db, [n1()], DAY)).get(n1());
    expect(u).toMatchObject({ total: 0, remaining: 20, limitReached: false });
    await k.seedUsage(n1(), DAY, { manual: 20 });
    const day1 = (await instanceUsage(k.t.db, [n1()], DAY)).get(n1());
    const day2 = (await instanceUsage(k.t.db, [n1()], NEXT_DAY)).get(n1());
    expect(day1?.limitReached).toBe(true);
    expect(day2).toMatchObject({ total: 0, limitReached: false }); // o dia seguinte começa em 0 sem ninguém zerar
    expect(await claimContactQuota(k.t.db, n1(), NEXT_DAY)).not.toBeNull();
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ total: 20 }); // o dia anterior não mudou
  });
});

// ---------- concorrência ----------

describe('cota diária: concorrência (o PostgreSQL decide, nunca a memória)', () => {
  const n1 = () => k.numbers[0];

  it('40 pedidos ao mesmo tempo para as 20 vagas do dia: exatamente 20 conseguem', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => claimContactQuota(k.t.db, n1(), DAY)));
    expect(results.filter(Boolean)).toHaveLength(20);
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ uncertain: 20, total: 20 });
  });

  it('19/20 e 60 pedidos ao mesmo tempo: só UM leva a última vaga (nunca 21)', async () => {
    await k.seedUsage(n1(), DAY, { manual: 10, automatic: 9 });
    const results = await Promise.all(Array.from({ length: 60 }, () => claimContactQuota(k.t.db, n1(), DAY)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await k.usageRow(n1(), DAY)).total).toBe(20);
  });

  it('vários PROCESSOS (conexões separadas) disputando: o total nunca passa de 20', async () => {
    const dbs = await workers(4);
    try {
      const results = (
        await Promise.all(
          dbs.map((db) => Promise.all(Array.from({ length: 15 }, () => claimContactQuota(db, n1(), DAY)))),
        )
      ).flat();
      expect(results.filter(Boolean)).toHaveLength(20);
      expect((await k.usageRow(n1(), DAY)).total).toBe(20);
    } finally {
      await closeAll(dbs);
    }
  });

  it('reinício: uma conexão nova enxerga o mesmo uso (10/20 continua 10/20) e segue de onde parou', async () => {
    for (let i = 0; i < 10; i++) {
      const claim = await claimContactQuota(k.t.db, n1(), DAY);
      await confirmContactQuota(k.t.db, claim as NonNullable<typeof claim>, i < 4 ? 'manual' : 'automatic');
    }
    const [fresh] = await workers(1);
    try {
      const u = (await instanceUsage(fresh as Db, [n1()], DAY)).get(n1());
      expect(u).toMatchObject({ manual: 4, automatic: 6, total: 10, remaining: 10 });
      const more = await Promise.all(
        Array.from({ length: 15 }, () => claimContactQuota(fresh as Db, n1(), DAY)),
      );
      expect(more.filter(Boolean)).toHaveLength(10);
    } finally {
      await closeAll([fresh as Db]);
    }
    expect((await k.usageRow(n1(), DAY)).total).toBe(20);
  });
});

// ---------- o botão Chamar (manual) ----------

describe('cota diária: o botão Chamar conta e respeita a cota', () => {
  const n1 = () => k.numbers[0];
  const n2 = () => k.numbers[1];

  it('o primeiro contato do Chamar (áudio enviado) conta como MANUAL; abrir a conversa sozinho não conta', async () => {
    await k.uploadAudio('Apresentação');
    const list = await k.newList(3, { assignTo: k.anaId });
    // Sem enviar áudio: só abre a conversa (e conferiu o WhatsApp do lead): nenhuma vaga gasta.
    const opened = await chamar(list.leadIds[0] as number, n1(), false);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(await k.usageRow(n1(), today())).toMatchObject({ total: 0 });
    expect(k.sends()).toHaveLength(0);
    // Enviando o áudio: um contato manual.
    const sent = await chamar(list.leadIds[1] as number, n1(), true);
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().audio).toMatchObject({ sent: true });
    expect(await k.usageRow(n1(), today())).toEqual({ manual: 1, automatic: 0, uncertain: 0, total: 1 });
    expect(k.sends()).toHaveLength(1);
  });

  it('a primeira mensagem DIGITADA para o lead (Chamar sem áudio) também é o contato, e conta uma vez só', async () => {
    const list = await k.newList(2, { assignTo: k.anaId });
    const opened = await chamar(list.leadIds[0] as number, n1(), false);
    const conversationId = opened.json().conversationId as number;
    expect(await k.usageRow(n1(), today())).toMatchObject({ total: 0 });
    const first = await k.ana.post(`/api/conversations/${conversationId}/messages`, {
      text: 'Olá! Tudo bem?',
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(await k.usageRow(n1(), today())).toEqual({ manual: 1, automatic: 0, uncertain: 0, total: 1 });
    // A segunda mensagem da mesma conversa NÃO é contato novo.
    expect(
      (await k.ana.post(`/api/conversations/${conversationId}/messages`, { text: 'Segue o material.' }))
        .statusCode,
    ).toBe(201);
    expect(await k.usageRow(n1(), today())).toMatchObject({ manual: 1, total: 1 });
  });

  it('20/20: o Chamar é RECUSADO com a mensagem legível, nada é enviado e o lead continua na fila', async () => {
    await k.uploadAudio('Apresentação');
    const list = await k.newList(3, { assignTo: k.anaId });
    await k.seedUsage(n1(), today(), { manual: 6, automatic: 14 });
    const r = await chamar(list.leadIds[0] as number, n1(), true);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe(LIMIT_MESSAGE);
    expect(r.json().code).toBe('limite_numero');
    expect(k.sends()).toHaveLength(0);
    expect(await k.usageRow(n1(), today())).toMatchObject({ manual: 6, automatic: 14, total: 20 });
    const lead = await k.t.db
      .selectFrom('leads')
      .select(['status', 'assigned_to'])
      .where('id', '=', list.leadIds[0] as number)
      .executeTakeFirstOrThrow();
    expect(lead).toMatchObject({ status: 'pendente', assigned_to: k.anaId });
    // O atendente não contorna escolhendo o mesmo número de novo: o backend é a autoridade.
    for (let i = 0; i < 3; i++)
      expect((await chamar(list.leadIds[0] as number, n1(), true)).statusCode).toBe(409);
    expect(k.sends()).toHaveLength(0);
    // Outro número, com a própria cota, continua funcionando.
    const other = await chamar(list.leadIds[1] as number, n2(), true);
    expect(other.statusCode, other.body).toBe(200);
    expect(await k.usageRow(n2(), today())).toMatchObject({ manual: 1, total: 1 });
    // A recusa fica na auditoria (padrão existente), sem nome nem telefone do lead.
    const audits = await k.numberLimitAudits({ instanceId: n1() });
    expect(audits.filter((a) => a.details.situacao === 'recusado').length).toBeGreaterThanOrEqual(4);
    expect(audits[0]?.details).toMatchObject({ origem: 'manual', total: 20, limite: 20 });
    expect(JSON.stringify(audits)).not.toContain(list.phones[0] as string);
  });

  it('19/20: o Chamar leva a última vaga e o seguinte é recusado (chega a 20/20, nunca 21)', async () => {
    await k.uploadAudio('Apresentação');
    const list = await k.newList(3, { assignTo: k.anaId });
    await k.seedUsage(n1(), today(), { manual: 9, automatic: 10 });
    expect((await chamar(list.leadIds[0] as number, n1(), true)).statusCode).toBe(200);
    expect(await k.usageRow(n1(), today())).toMatchObject({ manual: 10, automatic: 10, total: 20 });
    expect((await chamar(list.leadIds[1] as number, n1(), true)).statusCode).toBe(409);
    expect((await k.usageRow(n1(), today())).total).toBe(20);
    // Atingir o limite fica na auditoria do número.
    const audits = await k.numberLimitAudits({ instanceId: n1() });
    expect(audits.some((a) => a.details.situacao === 'atingido' && a.details.origem === 'manual')).toBe(true);
  });

  it('conversa que já tem mensagens NÃO é contato novo: chamar de novo ou responder não é barrado no 20/20', async () => {
    await k.uploadAudio('Apresentação');
    const list = await k.newList(2, { assignTo: k.anaId });
    const first = await chamar(list.leadIds[0] as number, n1(), true);
    expect(first.statusCode, first.body).toBe(200);
    const conversationId = first.json().conversationId as number;
    await k.seedUsage(n1(), today(), { manual: 20 });
    // O atendente escreve na conversa que já existe: continua funcionando com o número cheio.
    expect(
      (await k.ana.post(`/api/conversations/${conversationId}/messages`, { text: 'Só confirmando.' }))
        .statusCode,
    ).toBe(201);
    // Chamar o mesmo lead de novo (conversa já com mensagens): não é contato novo.
    expect((await chamar(list.leadIds[0] as number, n1(), true)).statusCode).toBe(200);
    expect(await k.usageRow(n1(), today())).toMatchObject({ manual: 20, total: 20 });
  });

  it('telefone sem WhatsApp não gasta vaga', async () => {
    await k.uploadAudio('Apresentação');
    const list = await k.newList(1, { assignTo: k.anaId });
    await k.t.db
      .updateTable('leads')
      .set({ phone: '5541999999999' })
      .where('id', '=', list.leadIds[0] as number)
      .execute();
    const r = await chamar(list.leadIds[0] as number, n1(), true);
    expect(r.statusCode).toBe(422);
    expect(await k.usageRow(n1(), today())).toMatchObject({ total: 0 });
  });

  it('a Evolution recusa (4xx): a vaga VOLTA; erro do servidor (5xx): a vaga FICA ocupada como incerta', async () => {
    await k.uploadAudio('Apresentação');
    const list = await k.newList(3, { assignTo: k.anaId });
    k.fake.failSends = { status: 400, message: 'Connection Closed' };
    await chamar(list.leadIds[0] as number, n1(), true);
    expect(await k.usageRow(n1(), today())).toEqual({ manual: 0, automatic: 0, uncertain: 0, total: 0 });
    k.fake.failSends = { status: 500, message: 'Internal error' };
    await chamar(list.leadIds[1] as number, n1(), true);
    // Pode ter saído: a vaga continua ocupada (incerta) e NÃO conta como manual.
    expect(await k.usageRow(n1(), today())).toEqual({ manual: 0, automatic: 0, uncertain: 1, total: 1 });
  });

  it('a tela de Números recebe o uso do dia do backend (manual + automático, com o limite)', async () => {
    await k.uploadAudio('Apresentação');
    const list = await k.newList(2, { assignTo: k.anaId });
    expect((await chamar(list.leadIds[0] as number, n1(), true)).statusCode).toBe(200);
    await k.seedUsage(n2(), today(), { manual: 3, automatic: 11 });
    const instances = (await k.admin.get('/api/instances')).json() as InstanceInfo[];
    const one = instances.find((i) => i.id === n1());
    const two = instances.find((i) => i.id === n2());
    expect(one?.usage).toMatchObject({
      date: today(),
      manual: 1,
      automatic: 0,
      total: 1,
      limit: 20,
      remaining: 19,
      limitReached: false,
    });
    expect(two?.usage).toMatchObject({
      manual: 3,
      automatic: 11,
      total: 14,
      remaining: 6,
      limitReached: false,
    });
    await k.seedUsage(n2(), today(), { manual: 6, automatic: 14 });
    const full = ((await k.admin.get('/api/instances')).json() as InstanceInfo[]).find((i) => i.id === n2());
    expect(full?.usage).toMatchObject({ total: 20, remaining: 0, limitReached: true });
    // O atendente vê o uso dos números que pode ver.
    const mine = (await k.ana.get('/api/instances')).json() as InstanceInfo[];
    expect(mine.find((i) => i.id === n1())?.usage.manual).toBe(1);
  });
});

// ---------- a campanha (automático) usa a MESMA cota ----------

describe('cota diária: a campanha considera o que já foi feito (manual incluído)', () => {
  const [n1, n2, n3] = [() => k.numbers[0], () => k.numbers[1], () => k.numbers[2]];

  it('número com 12 contatos manuais: a campanha enxerga 12/20 (restam 8) e envia só 8', async () => {
    await k.seedUsage(n1(), DAY, { manual: 12 });
    const c = await campaignWith({ leads: 30, numbers: [n1()] });
    const before = await getCampaign(k.t.db, c.automationId, c.campaignId, at(9, 0));
    expect(before.numbers[0]).toMatchObject({
      manualToday: 12,
      automaticToday: 0,
      usedToday: 12,
      remainingToday: 8,
      limitReached: false,
    });
    expect(before.availableToday).toBe(8);
    await k.simulate({ day: DAY });
    expect(k.sends()).toHaveLength(8);
    expect(await k.usageRow(n1(), DAY)).toEqual({ manual: 12, automatic: 8, uncertain: 0, total: 20 });
    const after = await getCampaign(k.t.db, c.automationId, c.campaignId, at(16, 5));
    expect(after.numbers[0]).toMatchObject({
      manualToday: 12,
      automaticToday: 8,
      usedToday: 20,
      remainingToday: 0,
      limitReached: true,
    });
    expect(after.availableToday).toBe(0);
    expect(after.eligibleLeads).toBe(22); // os outros ficam para amanhã
  });

  it('número que já chegou a 20 manuais fica FORA da campanha; os outros continuam (a campanha não para)', async () => {
    await k.seedUsage(n1(), DAY, { manual: 20 });
    const c = await campaignWith({ leads: 12, numbers: [n1(), n2()], extra: { dailyLimitPerNumber: 20 } });
    await k.simulate({ day: DAY });
    expect(k.sendsByNumber()).toEqual({ 'whatsapp-02': 12 });
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ manual: 20, automatic: 0, total: 20 }); // intocado
    expect(await k.usageRow(n2(), DAY)).toMatchObject({ automatic: 12, total: 12 });
    const runs = await k.campaignRuns(c.campaignId);
    expect(runs.every((r) => r.instance_id === n2())).toBe(true);
  });

  it('3 números com 18/20, 3/20 e 10/20: 2, 17 e 10 vagas; distribui e nenhum passa de 20', async () => {
    await k.seedUsage(n1(), DAY, { manual: 18 });
    await k.seedUsage(n2(), DAY, { manual: 1, automatic: 2 });
    await k.seedUsage(n3(), DAY, { manual: 10 });
    await k.uploadAudio('Áudio da campanha');
    const automationId = await k.makeAutomation([{ audio: 'random' }]);
    const list = await k.newList(60);
    const admin = k.adminUser;
    // A prévia (do servidor) já mostra a capacidade real de hoje: 2 + 17 + 10.
    const preview = await previewCampaign(
      k.t.db,
      admin,
      automationId,
      {
        listId: list.listId,
        instanceIds: [n1(), n2(), n3()],
        windowStart: '10:00',
        windowEnd: '16:00',
        dailyLimitPerNumber: 20,
        startDate: DAY,
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      },
      at(9, 0),
    );
    expect(preview.numbers.map((n) => [n.usedToday, n.remainingToday])).toEqual([
      [18, 2],
      [3, 17],
      [10, 10],
    ]);
    expect(preview.availableToday).toBe(29);
    expect(preview.dailyCapacity).toBe(60);
    const started = await k.startCampaign(automationId, list.listId, [n1(), n2(), n3()]);
    expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
    await k.simulate({ day: DAY });
    expect(k.sendsByNumber()).toEqual({ 'whatsapp-01': 2, 'whatsapp-02': 17, 'whatsapp-03': 10 });
    for (const id of [n1(), n2(), n3()]) expect((await k.usageRow(id, DAY)).total).toBe(20);
    const detail = await getCampaign(k.t.db, automationId, started.body.id, at(16, 5));
    expect(detail.numbers.every((n) => n.limitReached && n.remainingToday === 0)).toBe(true);
    expect(detail.availableToday).toBe(0);
    // Dia seguinte: todos voltam a 0/20 sozinhos, e a campanha continua com os 60 de capacidade.
    await k.simulate({ day: NEXT_DAY });
    expect(k.sends()).toHaveLength(29 + 31); // os 60 leads acabam em dois dias
    for (const id of [n1(), n2(), n3()])
      expect((await k.usageRow(id, NEXT_DAY)).total).toBeLessThanOrEqual(20);
  });

  it('número cheio não recebe lead novo: a própria fila não reserva para ele', async () => {
    const c = await campaignWith({ leads: 6, numbers: [n1(), n2()] });
    await k.seedUsage(n1(), DAY, { manual: 20 });
    // Direto na reserva: o número cheio é recusado e nenhuma participação é criada para ele.
    expect((await reserveNext(k.t.db, c.campaignId, n1(), at(10))).kind).toBe('limit');
    expect(await k.campaignRuns(c.campaignId)).toHaveLength(0);
    // No ciclo da fila: só o número com vaga recebe um lead.
    expect((await advanceCampaigns(k.t.db, { now: at(10) })).reserved).toBe(1);
    const runs = await k.campaignRuns(c.campaignId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.instance_id).toBe(n2());
  });

  it('participação reservada para um número que ENCHEU antes do envio vai para outro número com vaga', async () => {
    const c = await campaignWith({ leads: 6, numbers: [n1(), n2()] });
    const leadId = c.leadIds[0] as number;
    const runId = await dueRun({
      automationId: c.automationId,
      campaignId: c.campaignId,
      leadId,
      instanceId: n1(),
      nextRunAt: at(11),
    });
    await k.seedUsage(n1(), DAY, { manual: 20 }); // enquanto isso, o atendente encheu o número 1
    await runAutomationCycle(k.t.db, { now: at(11, 1) });
    const run = (await k.campaignRuns(c.campaignId)).find((r) => r.id === runId);
    // A mensagem ainda não tinha saído: é seguro trocar de número. Saiu pelo 2, e o 1 continua intocado.
    expect(run).toMatchObject({ status: 'completed', instance_id: n2() });
    expect(k.sendsByNumber()).toEqual({ 'whatsapp-02': 1 });
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ manual: 20, total: 20 });
    expect(await k.usageRow(n2(), DAY)).toMatchObject({ automatic: 1, total: 1 });
    const audit = await k.t.db
      .selectFrom('audit_log')
      .select('details')
      .where('action', '=', 'numero_trocado_campanha')
      .execute();
    expect(audit.some((a) => (a.details as Record<string, unknown>).execucao === runId)).toBe(true);
  });

  it('sem vaga em número nenhum: NÃO envia hoje e a participação espera o dia seguinte (sem passar de 20)', async () => {
    const c = await campaignWith({ leads: 4, numbers: [n1(), n2()] });
    await k.seedUsage(n1(), DAY, { manual: 20 });
    await k.seedUsage(n2(), DAY, { manual: 5, automatic: 15 });
    const runId = await dueRun({
      automationId: c.automationId,
      campaignId: c.campaignId,
      leadId: c.leadIds[0] as number,
      instanceId: n1(),
      nextRunAt: at(11),
    });
    await runAutomationCycle(k.t.db, { now: at(11, 1) });
    await runAutomationCycle(k.t.db, { now: at(11, 2) });
    expect(k.sends()).toHaveLength(0);
    const run = (await k.campaignRuns(c.campaignId)).find((r) => r.id === runId);
    expect(run).toMatchObject({ status: 'pending', current_step: 1 });
    expect(run?.next_run_at?.getTime()).toBeGreaterThanOrEqual(at(10, 0, 0, NEXT_DAY).getTime());
    expect((await k.usageRow(n1(), DAY)).total).toBe(20);
    expect((await k.usageRow(n2(), DAY)).total).toBe(20);
    // Amanhã a cota é outra: o mesmo lead sai e conta em AMANHÃ.
    await runAutomationCycle(k.t.db, { now: at(10, 1, 0, NEXT_DAY) });
    expect(k.sends()).toHaveLength(1);
    expect((await k.usageRow(n1(), NEXT_DAY)).total + (await k.usageRow(n2(), NEXT_DAY)).total).toBe(1);
    expect((await k.usageRow(n1(), DAY)).total).toBe(20);
    expect((await k.usageRow(n2(), DAY)).total).toBe(20);
    const refused = await k.numberLimitAudits({ campaignId: c.campaignId });
    expect(refused.some((a) => a.details.situacao === 'recusado')).toBe(true);
  });

  it('número desconectado ou excluído fica fora; com vaga e conectado entra', async () => {
    await k.seedUsage(n1(), DAY, { manual: 3 });
    const c = await campaignWith({ leads: 8, numbers: [n1(), n2()] });
    await k.t.db.updateTable('wa_instances').set({ status: 'close' }).where('id', '=', n2()).execute();
    await k.simulate({ from: 600, to: 800 });
    expect(Object.keys(k.sendsByNumber())).toEqual(['whatsapp-01']);
    const view = await getCampaign(k.t.db, c.automationId, c.campaignId, at(12));
    expect(view.numbers.find((n) => n.id === n2())).toMatchObject({ connected: false, usedToday: 0 });
    expect(view.availableToday).toBe(view.numbers.find((n) => n.id === n1())?.remainingToday); // o desconectado não soma
  });
});

// ---------- reserva x uso ----------

describe('cota diária: reservar não é contatar (a cota é do dia do envio)', () => {
  const n1 = () => k.numbers[0];

  it('25/09: 19 contatos; lead reservado para 26/09 e enviado em 26/09 → 25/09 = 19 e 26/09 = 1', async () => {
    const c = await campaignWith({ leads: 3, numbers: [n1()] });
    await k.seedUsage(n1(), DAY, { manual: 9, automatic: 10 });
    // Reserva técnica de "ontem": planejada em DAY para sair em NEXT_DAY.
    const runId = await dueRun({
      automationId: c.automationId,
      campaignId: c.campaignId,
      leadId: c.leadIds[0] as number,
      instanceId: n1(),
      nextRunAt: at(10, 0, 0, NEXT_DAY),
      slotDate: DAY,
    });
    await runAutomationCycle(k.t.db, { now: at(10, 0, 30, NEXT_DAY) });
    expect((await k.campaignRuns(c.campaignId)).find((r) => r.id === runId)?.status).toBe('completed');
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ manual: 9, automatic: 10, total: 19 }); // não virou 20
    expect(await k.usageRow(n1(), NEXT_DAY)).toMatchObject({ automatic: 1, total: 1 }); // o envio conta no dia dele
  });

  it('15:59: a reserva que só pode sair no dia seguinte não rouba a vaga do dia errado', async () => {
    const c = await campaignWith({ leads: 3, numbers: [n1()] });
    await k.seedUsage(n1(), DAY, { manual: 19 });
    expect((await advanceCampaigns(k.t.db, { now: at(15, 59) })).reserved).toBe(1);
    const reserved = (await k.campaignRuns(c.campaignId))[0];
    expect(reserved?.status).toBe('pending');
    // A reserva existe, mas nada foi gasto: o dia continua em 19.
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ total: 19 });
    // 16:00 (janela fechada): mesmo vencido, não sai; a cota de hoje segue livre para outros contatos.
    await runAutomationCycle(k.t.db, { now: at(16, 0) });
    await runAutomationCycle(k.t.db, { now: at(20, 0) });
    expect(k.sends()).toHaveLength(0);
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ total: 19 });
    // Dia seguinte, na abertura: sai e conta em AMANHÃ.
    await runAutomationCycle(k.t.db, { now: at(10, 0, 0, NEXT_DAY) });
    expect(k.sends()).toHaveLength(1);
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ total: 19 });
    expect(await k.usageRow(n1(), NEXT_DAY)).toMatchObject({ automatic: 1, total: 1 });
  });

  it('janela e cota são independentes: as DUAS precisam valer para enviar', async () => {
    const c = await campaignWith({ leads: 4, numbers: [n1()] });
    const run = (leadIndex: number, at_: Date) =>
      dueRun({
        automationId: c.automationId,
        campaignId: c.campaignId,
        leadId: c.leadIds[leadIndex] as number,
        instanceId: n1(),
        nextRunAt: at_,
      });
    // Janela aberta e cota cheia: não envia.
    await k.seedUsage(n1(), DAY, { manual: 20 });
    await run(0, at(11));
    await runAutomationCycle(k.t.db, { now: at(12) });
    expect(k.sends()).toHaveLength(0);
    // Cota livre e fora da janela: não envia.
    await k.seedUsage(n1(), DAY, { manual: 2 });
    await k.t.db
      .updateTable('automation_runs')
      .set({ next_run_at: at(9, 0), status: 'pending' })
      .execute();
    await runAutomationCycle(k.t.db, { now: at(9, 30) });
    await runAutomationCycle(k.t.db, { now: at(16, 30) });
    expect(k.sends()).toHaveLength(0);
    // Janela aberta e cota livre: envia.
    await k.t.db
      .updateTable('automation_runs')
      .set({ next_run_at: at(11), status: 'pending' })
      .execute();
    await runAutomationCycle(k.t.db, { now: at(12) });
    expect(k.sends()).toHaveLength(1);
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ manual: 2, automatic: 1, total: 3 });
  });
});

// ---------- resultado do envio automático ----------

describe('cota diária: o resultado do envio decide o que acontece com a vaga (campanha)', () => {
  const n1 = () => k.numbers[0];

  it('envio aceito → contato automático; a etapa 2 (acompanhamento) NÃO é contato novo', async () => {
    await k.uploadAudio('Áudio');
    const automationId = await k.makeAutomation([
      { audio: 'random' },
      { text: 'Conseguiu ouvir?', delaySeconds: 60 },
    ]);
    const list = await k.newList(2);
    const started = await k.startCampaign(automationId, list.listId, [n1()]);
    expect(started.statusCode).toBe(201);
    await k.simulate({ from: 600, to: 965 });
    expect(k.fake.calls.filter((c) => c.url.startsWith('/message/sendText/'))).toHaveLength(2);
    expect(await k.usageRow(n1(), DAY)).toEqual({ manual: 0, automatic: 2, uncertain: 0, total: 2 });
  });

  it('recusa clara (4xx) devolve a vaga; desconexão devolve e a repetição conta UMA vez; erro 5xx mantém a vaga', async () => {
    const c = await campaignWith({ leads: 3, numbers: [n1()] });
    const lead = (i: number) => c.leadIds[i] as number;
    const make = (i: number) =>
      dueRun({
        automationId: c.automationId,
        campaignId: c.campaignId,
        leadId: lead(i),
        instanceId: n1(),
        nextRunAt: at(11),
      });

    // 1) desconectado: a mensagem não saiu, a vaga volta, e a repetição depois conta uma vez só.
    const first = await make(0);
    k.fake.failSends = { status: 400, message: 'Connection Closed' };
    await runAutomationCycle(k.t.db, { now: at(11, 1) });
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ total: 0 });
    k.fake.failSends = null;
    await runAutomationCycle(k.t.db, { now: at(11, 10) });
    expect((await k.campaignRuns(c.campaignId)).find((r) => r.id === first)?.status).toBe('completed');
    expect(await k.usageRow(n1(), DAY)).toEqual({ manual: 0, automatic: 1, uncertain: 0, total: 1 });

    // 2) recusa definitiva (4xx que não é desconexão): não saiu, a vaga volta.
    const second = await make(1);
    k.fake.failSends = { status: 400, message: 'número inválido' };
    await runAutomationCycle(k.t.db, { now: at(11, 20) });
    expect((await k.campaignRuns(c.campaignId)).find((r) => r.id === second)).toMatchObject({
      status: 'failed',
      cancel_reason: 'envio_recusado',
    });
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ automatic: 1, total: 1 });

    // 3) erro do servidor (5xx): pode ter saído. A vaga FICA ocupada (incerta), a etapa não é reenviada.
    const third = await make(2);
    k.fake.failSends = { status: 500, message: 'Internal error' };
    await runAutomationCycle(k.t.db, { now: at(11, 30) });
    k.fake.failSends = null;
    expect((await k.campaignRuns(c.campaignId)).find((r) => r.id === third)).toMatchObject({
      status: 'failed',
      cancel_reason: 'resultado_incerto',
    });
    await runAutomationCycle(k.t.db, { now: at(12, 0) });
    await runAutomationCycle(k.t.db, { now: at(13, 0) });
    expect(await k.usageRow(n1(), DAY)).toEqual({ manual: 0, automatic: 1, uncertain: 1, total: 2 });
    expect(k.sends()).toHaveLength(4); // 1 recusado por desconexão + 1 aceito + 1 recusado + 1 incerto; nenhum reenvio às cegas
  });

  it('telefone sem WhatsApp não gasta vaga', async () => {
    const c = await campaignWith({ leads: 2, numbers: [n1()] });
    await k.t.db
      .updateTable('leads')
      .set({ phone: '5541999999999' })
      .where('id', '=', c.leadIds[0] as number)
      .execute();
    await k.simulate({ from: 600, to: 965 });
    expect(k.sends()).toHaveLength(1);
    expect(await k.usageRow(n1(), DAY)).toEqual({ manual: 0, automatic: 1, uncertain: 0, total: 1 });
  });
});

// ---------- o teste mais importante: manual + automático ao mesmo tempo ----------

describe('cota diária: Chamar manual e campanha disputando a última vaga', () => {
  const n1 = () => k.numbers[0];

  it('19/20 com o Chamar e a campanha ao mesmo tempo: só UMA das duas leva a vaga; o número termina em 20/20', async () => {
    await k.uploadAudio('Áudio');
    const c = await campaignWith({ leads: 12, numbers: [n1()], audio: false });
    const day = today(); // o Chamar usa o relógio de verdade; a campanha, o mesmo dia às 12:00
    let manualWins = 0;
    let campaignWins = 0;
    for (let round = 0; round < 10; round++) {
      await k.seedUsage(n1(), day, { manual: 10, automatic: 9 }); // 19/20
      const manualLead = (await k.newList(1, { assignTo: k.anaId })).leadIds[0] as number;
      const runId = await dueRun({
        automationId: c.automationId,
        campaignId: c.campaignId,
        leadId: c.leadIds[round] as number,
        instanceId: n1(),
        nextRunAt: at(11, 0, 0, day),
        slotDate: day,
      });
      const sendsBefore = k.sends().length;
      const [manual, cycle] = await Promise.all([
        chamar(manualLead, n1(), true),
        runAutomationCycle(k.t.db, { now: at(12, 0, 0, day), batchSize: 5 }),
      ]);
      const manualOk = manual.statusCode === 200;
      const autoSent =
        (await k.campaignRuns(c.campaignId)).find((r) => r.id === runId)?.status === 'completed';
      // Nunca as duas, nunca nenhuma: existia UMA vaga.
      expect(Number(manualOk) + Number(autoSent), `rodada ${round + 1}`).toBe(1);
      expect((await k.usageRow(n1(), day)).total, `rodada ${round + 1}`).toBe(20);
      expect(k.sends().length - sendsBefore, `envios da rodada ${round + 1}`).toBe(1);
      if (!manualOk) expect(manual.json().error).toBe(LIMIT_MESSAGE);
      if (manualOk) manualWins++;
      else campaignWins++;
      void cycle;
    }
    expect(manualWins + campaignWins).toBe(10);
  });

  it('em paralelo com VÁRIOS workers: 3 workers, 20 vagas, 50 leads → exatamente 20 contatos', async () => {
    const c = await campaignWith({ leads: 50, numbers: [n1()] });
    const dbs = await workers(3);
    try {
      for (let minute = 600; minute <= 965; minute++) {
        const now = at(Math.floor(minute / 60), minute % 60);
        await Promise.all(dbs.map((db) => k.tick(now, db)));
      }
    } finally {
      await closeAll(dbs);
    }
    expect(k.sends()).toHaveLength(20);
    expect(new Set(k.sends().map((s) => String((s.body as { number: string }).number))).size).toBe(20);
    expect(await k.usageRow(n1(), DAY)).toEqual({ manual: 0, automatic: 20, uncertain: 0, total: 20 });
    const runs = await k.campaignRuns(c.campaignId);
    expect(runs.filter((r) => r.status === 'completed')).toHaveLength(20);
  });

  it('reinício no meio do dia: a contagem não zera e o limite continua valendo', async () => {
    const c = await campaignWith({ leads: 40, numbers: [n1()] });
    await k.simulate({ from: 600, to: 780 });
    const morning = (await k.usageRow(n1(), DAY)).total;
    expect(morning).toBeGreaterThan(3);
    expect(morning).toBeLessThan(20);
    const [fresh] = await workers(1);
    try {
      expect((await instanceUsage(fresh as Db, [n1()], DAY)).get(n1())?.total).toBe(morning); // "reiniciou": mesmo número
      await k.simulate({ from: 781, to: 965, db: fresh as Db });
    } finally {
      await closeAll([fresh as Db]);
    }
    expect((await k.usageRow(n1(), DAY)).total).toBe(20);
    expect(k.sends()).toHaveLength(20);
    void c;
  });
});

// ---------- áudio: nada quebra ----------

describe('cota diária: o sorteio de áudio continua independente da cota', () => {
  const n1 = () => k.numbers[0];

  it('o Chamar e a campanha usam a MESMA biblioteca, cada um com o seu saco; o áudio segue registrado', async () => {
    const audios = [
      await k.uploadAudio('Áudio 1'),
      await k.uploadAudio('Áudio 2'),
      await k.uploadAudio('Áudio 3'),
    ];
    const list = await k.newList(3, { assignTo: k.anaId });
    for (let i = 0; i < 3; i++)
      expect((await chamar(list.leadIds[i] as number, n1(), true)).statusCode).toBe(200);
    // Manual: três contatos, três áudios diferentes (o rodízio persistente por número).
    const manualBodies = k.sends().map(audioBody);
    expect(new Set(manualBodies).size).toBe(3);
    expect(await k.usageRow(n1(), today())).toMatchObject({ manual: 3, total: 3 });
    expect(
      (
        await k.t.db
          .selectFrom('wa_audio_bags')
          .select('scope')
          .where('scope', '=', `instance:${n1()}`)
          .executeTakeFirst()
      )?.scope,
    ).toBe(`instance:${n1()}`);

    const c = await campaignWith({ leads: 6, numbers: [n1()], audio: false });
    await k.simulate({ from: 600, to: 965 });
    const steps = await k.t.db
      .selectFrom('automation_step_runs as sr')
      .innerJoin('automation_runs as r', 'r.id', 'sr.automation_run_id')
      .select(['sr.audio_id', 'sr.audio_label'])
      .where('r.campaign_id', '=', c.campaignId)
      .orderBy('sr.id')
      .execute();
    expect(steps).toHaveLength(6);
    expect(steps.every((s) => audios.some((a) => a.id === s.audio_id) && s.audio_label)).toBe(true);
    expect(
      await k.t.db
        .selectFrom('wa_audio_bags')
        .select('scope')
        .where('scope', '=', `campaign:${c.campaignId}`)
        .executeTakeFirst(),
    ).toBeTruthy();
    // A cota contou 3 manuais + 6 automáticos, sem relação com QUAL áudio saiu.
    expect(await k.usageRow(n1(), DAY)).toMatchObject({ automatic: 6 });
  });

  it('um Chamar recusado pela cota NÃO gasta um sorteio do saco de áudios', async () => {
    await k.uploadAudio('Áudio 1');
    await k.uploadAudio('Áudio 2');
    const list = await k.newList(2, { assignTo: k.anaId });
    expect((await chamar(list.leadIds[0] as number, n1(), true)).statusCode).toBe(200);
    const bag = await k.t.db
      .selectFrom('wa_audio_bags')
      .selectAll()
      .where('scope', '=', `instance:${n1()}`)
      .executeTakeFirstOrThrow();
    await k.seedUsage(n1(), today(), { manual: 20 });
    expect((await chamar(list.leadIds[1] as number, n1(), true)).statusCode).toBe(409);
    const after = await k.t.db
      .selectFrom('wa_audio_bags')
      .selectAll()
      .where('scope', '=', `instance:${n1()}`)
      .executeTakeFirstOrThrow();
    expect(after.remaining).toEqual(bag.remaining);
    expect(after.last_audio_id).toBe(bag.last_audio_id);
  });
});

// ---------- gatilho manual (POST /automations/:id/run): a MESMA cota ----------

describe('cota diária: a execução manual (/run) também é contato novo', () => {
  const n1 = () => k.numbers[0];
  const n2 = () => k.numbers[1];
  const nowPlus = (seconds: number) => new Date(Date.now() + seconds * 1000);
  const run = (automationId: number, leadId: number, instanceId: number) =>
    k.admin.post(`/api/automations/${automationId}/run`, { leadId, instanceId });
  const texts = () => k.fake.calls.filter((c) => c.url.startsWith('/message/sendText/'));
  const cycle = (seconds = 5) => runAutomationCycle(k.t.db, { now: nowPlus(seconds), batchSize: 20 });
  const runStatus = async (id: number) =>
    (
      await k.t.db
        .selectFrom('automation_runs')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).status;

  it('o primeiro envio de um /run conta como contato AUTOMÁTICO na cota do número', async () => {
    const automationId = await k.makeAutomation([{ text: 'Olá!' }]);
    const [lead] = (await k.newList(1)).leadIds as [number];
    expect((await run(automationId, lead, n1())).statusCode).toBe(201);
    expect(await k.usageRow(n1(), today())).toMatchObject({ total: 0 }); // criar a participação não gasta vaga
    await cycle();
    expect(texts()).toHaveLength(1);
    expect(await k.usageRow(n1(), today())).toEqual({ manual: 0, automatic: 1, uncertain: 0, total: 1 });
  });

  it('a etapa 2 do mesmo /run NÃO é contato novo (acompanhamento)', async () => {
    const automationId = await k.makeAutomation([{ text: 'Primeira' }, { text: 'Segunda', delaySeconds: 1 }]);
    const [lead] = (await k.newList(1)).leadIds as [number];
    await run(automationId, lead, n1());
    await cycle(5);
    await cycle(20);
    expect(texts()).toHaveLength(2);
    expect(await k.usageRow(n1(), today())).toMatchObject({ automatic: 1, total: 1 });
  });

  it('20/20: o /run é RECUSADO com a mensagem legível, sem criar participação e com auditoria', async () => {
    const automationId = await k.makeAutomation([{ text: 'Olá!' }]);
    const [lead] = (await k.newList(1)).leadIds as [number];
    await k.seedUsage(n1(), today(), { manual: 12, automatic: 8 });
    const r = await run(automationId, lead, n1());
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe(LIMIT_MESSAGE);
    expect(await k.t.db.selectFrom('automation_runs').select('id').execute()).toEqual([]);
    expect(k.sends()).toHaveLength(0);
    const audits = await k.numberLimitAudits({ instanceId: n1() }); // a auditoria não é zerada entre os testes: vale a última
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.at(-1)?.details).toMatchObject({ origem: 'api', situacao: 'recusado', total: 20 });
    // Outro número, com vaga, aceita.
    expect((await run(automationId, lead, n2())).statusCode).toBe(201);
  });

  it('a cota encheu DEPOIS de criar o /run: o executor não envia, adia para amanhã e nada passa de 20', async () => {
    const automationId = await k.makeAutomation([{ text: 'Olá!' }]);
    const [lead] = (await k.newList(1)).leadIds as [number];
    const created = await run(automationId, lead, n1());
    expect(created.statusCode).toBe(201);
    await k.seedUsage(n1(), today(), { manual: 20 }); // o número encheu (Chamar) antes do envio
    await cycle();
    expect(texts()).toHaveLength(0);
    const row = await k.t.db
      .selectFrom('automation_runs')
      .select(['status', 'next_run_at'])
      .where('id', '=', created.json().id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
    expect((row.next_run_at as Date).getTime()).toBeGreaterThan(Date.now() + 60_000); // só amanhã, começo do dia
    expect((await k.usageRow(n1(), today())).total).toBe(20);
    // Amanhã o contato conta na cota de amanhã.
    const tomorrow = new Date((row.next_run_at as Date).getTime() + 60_000);
    await runAutomationCycle(k.t.db, { now: tomorrow, batchSize: 5 });
    expect(texts()).toHaveLength(1);
    expect((await k.usageRow(n1(), today())).total).toBe(20);
  });

  it('19/20: um /run já criado e o Chamar disputam a última vaga — só UM leva, nunca 21', async () => {
    const automationId = await k.makeAutomation([{ text: 'Olá!' }]);
    await k.uploadAudio('Áudio');
    let manualWins = 0;
    let runWins = 0;
    for (let round = 0; round < 8; round++) {
      await k.seedUsage(n1(), today(), { manual: 10, automatic: 9 }); // 19/20
      const [runLead] = (await k.newList(1)).leadIds as [number];
      const [manualLead] = (await k.newList(1, { assignTo: k.anaId })).leadIds as [number];
      const created = await run(automationId, runLead, n1());
      expect(created.statusCode, `rodada ${round + 1}`).toBe(201);
      const before = k.sends().length;
      const [manual] = await Promise.all([chamar(manualLead, n1(), true), cycle(5)]);
      const sentByRun = (await runStatus(created.json().id)) === 'completed';
      const manualOk = manual.statusCode === 200;
      expect(Number(manualOk) + Number(sentByRun), `rodada ${round + 1}`).toBe(1);
      expect((await k.usageRow(n1(), today())).total, `rodada ${round + 1}`).toBe(20);
      expect(k.sends().length - before).toBe(1);
      if (manualOk) manualWins++;
      else runWins++;
      // Limpa a participação que ficou esperando amanhã, para a próxima rodada.
      await k.t.db.deleteFrom('automation_runs').where('id', '=', created.json().id).execute();
    }
    expect(manualWins + runWins).toBe(8);
  });

  it('/run + campanha + manual disputando o mesmo número: o total do dia nunca passa de 20', async () => {
    await campaignWith({ leads: 30, numbers: [n1()] });
    const other = await k.makeAutomation([{ text: 'Avulsa' }]);
    const runLeads = (await k.newList(12)).leadIds;
    const manualLeads = (await k.newList(12, { assignTo: k.anaId })).leadIds;
    await k.seedUsage(n1(), today(), { manual: 4 });
    for (const id of runLeads) expect((await run(other, id, n1())).statusCode).toBe(201);
    await Promise.all([
      ...manualLeads.map((id) => chamar(id, n1(), true)),
      cycle(5),
      cycle(6),
      runAutomationCycle(k.t.db, { now: at(12, 0, 0, today()), batchSize: 10 }),
    ]);
    const row = await k.usageRow(n1(), today());
    expect(row.total).toBeLessThanOrEqual(20);
    expect(row.manual + row.automatic + row.uncertain).toBe(row.total);
  });

  it('o gatilho "lead chamado" não é contato novo: o Chamar já contou, o acompanhamento não conta de novo', async () => {
    const created = await k.admin.post('/api/automations', {
      name: 'Depois do Chamar',
      trigger: 'lead_called',
    });
    expect(created.statusCode).toBe(201);
    const automationId = created.json().id as number;
    await k.admin.post(`/api/automations/${automationId}/steps`, {
      actionType: 'send_text',
      delaySeconds: 0,
      messageText: 'Obrigado pelo contato!',
      audioId: null,
      audioMode: 'fixed',
      conditions: [],
    });
    expect(
      (await k.admin.patch(`/api/automations/${automationId}/status`, { status: 'active' })).statusCode,
    ).toBe(200);
    await k.uploadAudio('Áudio');
    const [lead] = (await k.newList(1, { assignTo: k.anaId })).leadIds as [number];
    expect((await chamar(lead, n1(), true)).statusCode).toBe(200);
    expect(await k.usageRow(n1(), today())).toMatchObject({ manual: 1, total: 1 });
    await cycle(5);
    expect(texts()).toHaveLength(1);
    expect(await k.usageRow(n1(), today())).toEqual({ manual: 1, automatic: 0, uncertain: 0, total: 1 });
  });
});
