import { describe, expect, it } from 'vitest';
import { createDb, createPool } from '../../src/server/db';
import { getCampaign } from '../../src/server/modules/automations/campaigns';
import { runAutomationCycle } from '../../src/server/modules/automations/executor';
import { RETRY_SECONDS } from '../../src/server/modules/automations/schedule';
import { pickAudio, pickAudioForInstance } from '../../src/server/modules/whatsapp/audios';
import { at, campaignKit, type StepSpec } from '../campaign-kit';

// O sorteio de áudio: rodízio em "saco embaralhado" guardado no PostgreSQL (`wa_audio_bags`), usado pelas
// campanhas e pelo botão Chamar. Aqui se prova: só áudios ativos, sem repetir em seguida, todos saem antes de
// qualquer um repetir, número e áudio sorteados de forma independente, sobrevive a reinício e a concorrência, e o
// áudio fica gravado ANTES de o envio ir para a Evolution.

const k = campaignKit();

const destination = (call: { body: unknown }) =>
  String((call.body as { number: string }).number).split('@')[0];
const instanceName = (call: { url: string }) => call.url.split('/').pop() ?? '';

async function library(count: number): Promise<{ id: number; bytes: Buffer; label: string }[]> {
  const items = [];
  for (let i = 0; i < count; i++) {
    const label = `Áudio ${i + 1}`;
    items.push({ ...(await k.uploadAudio(label)), label });
  }
  return items;
}

const noImmediateRepeat = (ids: number[]) => ids.every((id, i) => i === 0 || id !== ids[i - 1]);
const bagOf = (scope: string) =>
  k.t.db.selectFrom('wa_audio_bags').selectAll().where('scope', '=', scope).executeTakeFirst();
const setActive = async (id: number, active: boolean) => {
  const r = await k.admin.patch(`/api/audios/${id}`, { active });
  expect(r.statusCode, r.body).toBe(200);
};

async function campaign(o: {
  leads: number;
  numbers?: number[];
  steps: (audios: { id: number }[]) => StepSpec[];
  audios: { id: number }[];
  extra?: Record<string, unknown>;
}) {
  const automationId = await k.makeAutomation(o.steps(o.audios));
  const list = await k.newList(o.leads);
  const started = await k.startCampaign(
    automationId,
    list.listId,
    o.numbers ?? [k.numbers[0], k.numbers[1]],
    o.extra,
  );
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  return { automationId, ...list, campaignId: started.body.id };
}

/** As tentativas de etapa (uma por envio), na ordem em que aconteceram. */
const stepRunsOf = (campaignId: number) =>
  k.t.db
    .selectFrom('automation_step_runs as sr')
    .innerJoin('automation_runs as r', 'r.id', 'sr.automation_run_id')
    .select([
      'sr.id',
      'sr.status',
      'sr.error',
      'sr.audio_id',
      'sr.audio_label',
      'sr.message_id',
      'r.instance_id',
      'r.lead_id',
    ])
    .where('r.campaign_id', '=', campaignId)
    .orderBy('sr.id')
    .execute();

// ---------- o rodízio ----------

describe('rodízio de áudios (saco embaralhado no banco)', () => {
  it('só sorteia áudios ATIVOS: o desligado nunca sai e o que foi excluído sai do saco', async () => {
    const [a, b, c] = await library(3);
    await setActive((a as { id: number }).id, false);
    const picks = [];
    for (let i = 0; i < 30; i++) picks.push((await pickAudio(k.t.db, 'teste:ativos'))?.id as number);
    expect(new Set(picks)).toEqual(new Set([(b as { id: number }).id, (c as { id: number }).id]));
    expect(noImmediateRepeat(picks)).toBe(true);

    // Excluir da biblioteca também tira do rodízio, no meio do ciclo.
    await k.admin.post(`/api/audios/${(b as { id: number }).id}/delete`, {});
    const after = [];
    for (let i = 0; i < 6; i++) after.push((await pickAudio(k.t.db, 'teste:ativos'))?.id as number);
    expect(new Set(after)).toEqual(new Set([(c as { id: number }).id]));
    // Voltando a ligar o primeiro, ele entra de novo (a partir do próximo ciclo).
    await setActive((a as { id: number }).id, true);
    const back = new Set<number>();
    for (let i = 0; i < 6; i++) back.add((await pickAudio(k.t.db, 'teste:ativos'))?.id as number);
    expect(back).toEqual(new Set([(a as { id: number }).id, (c as { id: number }).id]));
  });

  it('todos saem uma vez antes de qualquer um repetir, e o mesmo áudio nunca sai duas vezes seguidas', async () => {
    const audios = await library(3);
    const ids = new Set(audios.map((x) => x.id));
    const picks: number[] = [];
    for (let i = 0; i < 90; i++) picks.push((await pickAudio(k.t.db, 'teste:ciclos'))?.id as number);
    expect(noImmediateRepeat(picks)).toBe(true); // inclusive na virada de um saco para o outro
    for (let block = 0; block < picks.length; block += 3) {
      expect(new Set(picks.slice(block, block + 3)), `ciclo ${block / 3 + 1}`).toEqual(ids);
    }
  });

  it('com um áudio só, sai sempre ele; sem nenhum ativo, não há o que sortear', async () => {
    const [only] = await library(1);
    for (let i = 0; i < 5; i++) expect((await pickAudio(k.t.db, 'teste:um'))?.id).toBe(only?.id);
    await setActive(only?.id as number, false);
    expect(await pickAudio(k.t.db, 'teste:um')).toBeNull();
  });

  it('cada escopo (campanha, automação, número do Chamar) tem o seu saco', async () => {
    const audios = await library(3);
    const first = await pickAudio(k.t.db, 'teste:A');
    const bagA = await bagOf('teste:A');
    expect(bagA?.remaining).toHaveLength(2);
    expect(bagA?.remaining).not.toContain(first?.id);
    expect(bagA?.last_audio_id).toBe(first?.id);
    // Mexer em B não muda o saco de A.
    for (let i = 0; i < 5; i++) await pickAudio(k.t.db, 'teste:B');
    expect((await bagOf('teste:A'))?.remaining).toEqual(bagA?.remaining);
    expect(audios.map((x) => x.id)).toContain(first?.id);
    const instance = await pickAudioForInstance(k.t.db, k.numbers[0]);
    expect(instance).not.toBeNull();
    expect(await bagOf(`instance:${k.numbers[0]}`)).toBeTruthy();
  });

  it('o saco fica no banco: uma conexão nova (reinício) continua o mesmo ciclo, sem repetir nem pular', async () => {
    const audios = await library(3);
    const ids = new Set(audios.map((x) => x.id));
    const one = await pickAudio(k.t.db, 'teste:reinicio');
    const fresh = createDb(createPool(k.t.url, 2)); // "processo novo": nada em memória
    try {
      const two = await pickAudio(fresh, 'teste:reinicio');
      const three = await pickAudio(fresh, 'teste:reinicio');
      expect(new Set([one?.id, two?.id, three?.id])).toEqual(ids); // o ciclo foi completado sem repetir
    } finally {
      await fresh.destroy();
    }
    expect((await bagOf('teste:reinicio'))?.remaining).toEqual([]);
  });

  it('concorrência: 30 sorteios ao mesmo tempo dão 10 de cada (ninguém leva o mesmo "próximo áudio")', async () => {
    const audios = await library(3);
    const results = await Promise.all(
      Array.from({ length: 30 }, () => pickAudio(k.t.db, 'teste:concorrente')),
    );
    const counts = new Map<number, number>();
    for (const r of results) counts.set(r?.id as number, (counts.get(r?.id as number) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual(audios.map((a) => a.id).sort());
    expect([...counts.values()]).toEqual([10, 10, 10]);
  });

  it('o "Chamar" manual usa o mesmo rodízio persistente, um saco por número', async () => {
    await library(2);
    const first = await pickAudioForInstance(k.t.db, k.numbers[0]);
    const second = await pickAudioForInstance(k.t.db, k.numbers[0]);
    expect(first?.id).not.toBe(second?.id);
    expect((await bagOf(`instance:${k.numbers[0]}`))?.remaining).toEqual([]);
    // Outro número tem o seu próprio saco.
    expect(await bagOf(`instance:${k.numbers[1]}`)).toBeUndefined();
  });
});

// ---------- na campanha ----------

describe('campanha com áudio sorteado', () => {
  it('o áudio enviado é o registrado no histórico; nada repete em seguida; número e áudio são sorteados sem ligação', async () => {
    const audios = await library(3);
    const c = await campaign({
      leads: 24,
      audios,
      steps: () => [{ audio: 'random' }],
      extra: { dailyLimitPerNumber: 12 },
    });
    await k.simulate({});
    const runs = await stepRunsOf(c.campaignId);
    expect(runs).toHaveLength(24);
    const sequence = runs.map((r) => r.audio_id as number);
    expect(noImmediateRepeat(sequence)).toBe(true);
    for (let block = 0; block < sequence.length; block += 3) {
      expect(new Set(sequence.slice(block, block + 3)).size, `bloco ${block / 3 + 1}`).toBe(3);
    }
    // Os bytes que a Evolution recebeu são os do áudio registrado (o sorteado, e nenhum outro).
    const byId = new Map(audios.map((a) => [a.id, a.bytes.toString('base64')]));
    const calls = k.sends();
    for (const run of runs) {
      const phone = (
        await k.t.db
          .selectFrom('leads')
          .select('phone')
          .where('id', '=', run.lead_id)
          .executeTakeFirstOrThrow()
      ).phone;
      const call = calls.find((x) => destination(x) === phone);
      expect((call as { body: { audio: string } }).body.audio).toBe(byId.get(run.audio_id as number));
      expect(run.audio_label).toMatch(/^Áudio \d$/);
    }
    // Independentes: cada número recebeu áudios variados (não existe "número 1 = áudio 1").
    for (const numberId of [k.numbers[0], k.numbers[1]]) {
      const used = new Set(runs.filter((r) => r.instance_id === numberId).map((r) => r.audio_id));
      expect(used.size, `número ${numberId}`).toBeGreaterThanOrEqual(2);
    }
    const perAudio = new Map<number, number>();
    for (const id of sequence) perAudio.set(id, (perAudio.get(id) ?? 0) + 1);
    expect([...perAudio.values()]).toEqual([8, 8, 8]);
    // O saco da campanha está no banco (não na memória).
    expect(await bagOf(`campaign:${c.campaignId}`)).toBeTruthy();
  });

  it('áudio desligado ou excluído no meio da campanha sai do sorteio; o histórico mantém o nome', async () => {
    const audios = await library(3);
    const [x, y, z] = audios as [(typeof audios)[number], (typeof audios)[number], (typeof audios)[number]];
    const c = await campaign({
      leads: 30,
      audios,
      numbers: [k.numbers[0]],
      steps: () => [{ audio: 'random' }],
    });
    await k.simulate({ from: 600, to: 700 });
    const before = (await stepRunsOf(c.campaignId)).length;
    expect(before).toBeGreaterThanOrEqual(4);

    await setActive(x.id, false);
    await k.admin.post(`/api/audios/${y.id}/delete`, {});
    await k.simulate({ from: 701, to: 965 });
    const all = await stepRunsOf(c.campaignId);
    expect(all.length).toBeGreaterThan(before + 3);
    const later = all.slice(before);
    // Depois da mudança, só o áudio que sobrou (a etapa que já estava em andamento pode ter usado o anterior).
    expect(later.slice(1).every((r) => r.audio_id === z.id)).toBe(true);
    // O histórico guarda o nome de quem saiu do sorteio, mesmo excluído (o id fica vazio).
    const deleted = all.find((r) => r.audio_label === y.label);
    expect(deleted).toBeTruthy();
    expect(deleted?.audio_id).toBeNull();
    expect(all.some((r) => r.audio_label === x.label)).toBe(true);
    const runsApi = (
      await k.admin.get(`/api/automations/${c.automationId}/runs?campaignId=${c.campaignId}&limit=200`)
    ).json();
    const labels = new Set(
      runsApi.flatMap((r: { steps: { audio: { label: string } | null }[] }) =>
        r.steps.map((s) => s.audio?.label),
      ),
    );
    expect(labels.has(y.label)).toBe(true);
  });

  it('nenhum áudio ativo na hora do envio: a etapa falha com o motivo, nada é enviado e a vaga não é gasta', async () => {
    const audios = await library(2);
    const c = await campaign({
      leads: 3,
      audios,
      numbers: [k.numbers[0]],
      steps: () => [{ audio: 'random' }],
    });
    await k.tick(at(9, 0)); // reserva o primeiro lead; o envio é às 10:00
    for (const audio of audios) await setActive(audio.id, false);
    await k.tick(at(10, 1));
    expect(k.sends()).toHaveLength(0);
    const [run] = await k.t.db
      .selectFrom('automation_runs')
      .select(['status', 'cancel_reason'])
      .where('campaign_id', '=', c.campaignId)
      .orderBy('id')
      .execute();
    expect(run).toMatchObject({ status: 'failed', cancel_reason: 'audio_indisponivel' });
    const [step] = await stepRunsOf(c.campaignId);
    expect(step).toMatchObject({ status: 'failed' });
    expect(step?.error).toMatch(/áudio ativo/);
    expect(step?.audio_id).toBeNull();
    const view = await getCampaign(k.t.db, c.automationId, c.campaignId, at(10, 2));
    expect(view.numbers[0]?.usedToday).toBe(0);
  });

  it('o áudio fica gravado ANTES de o envio ir para a Evolution (mesmo que o envio dê erro)', async () => {
    const audios = await library(3);
    const c = await campaign({
      leads: 2,
      audios,
      numbers: [k.numbers[0]],
      steps: () => [{ audio: 'random' }],
    });
    await k.tick(at(9, 0));
    k.fake.failSends = { status: 500, message: 'erro interno da Evolution' };
    await k.tick(at(10, 1));
    const [step] = await stepRunsOf(c.campaignId);
    // Resultado incerto (5xx): não reenviou. Mas o áudio sorteado já estava gravado, com o nome.
    expect(step).toMatchObject({ status: 'failed', message_id: null });
    expect(step?.error).toMatch(/não foi reenviada/i);
    expect(audios.map((a) => a.id)).toContain(step?.audio_id);
    expect(step?.audio_label).toMatch(/^Áudio \d$/);
    expect((await bagOf(`campaign:${c.campaignId}`))?.last_audio_id).toBe(step?.audio_id);
    // A mensagem não foi gravada em nenhuma conversa (nada saiu).
    const messages = await k.t.db
      .selectFrom('wa_messages as m')
      .innerJoin('wa_conversations as cv', 'cv.id', 'm.conversation_id')
      .select('m.id')
      .where('cv.lead_id', 'in', c.leadIds)
      .execute();
    expect(messages).toHaveLength(0);
  });

  it('número desconectado na hora do envio: repete depois com o MESMO áudio, sem gastar outro do rodízio', async () => {
    const audios = await library(3);
    const c = await campaign({
      leads: 2,
      audios,
      numbers: [k.numbers[0]],
      steps: () => [{ audio: 'random' }],
    });
    await k.tick(at(9, 0));
    k.fake.failSends = { status: 400, message: 'Connection Closed' }; // a Evolution recusa: número desconectado
    await runAutomationCycle(k.t.db, { now: at(10, 1) });
    let [step] = await stepRunsOf(c.campaignId);
    expect(step).toMatchObject({ status: 'pending' }); // a mensagem sabidamente não saiu: pode repetir
    const drawn = step?.audio_id;
    expect(drawn).not.toBeNull();
    expect(k.sends()).toHaveLength(1); // a tentativa que a Evolution recusou
    expect((await bagOf(`campaign:${c.campaignId}`))?.remaining).toHaveLength(2);

    k.fake.failSends = null;
    await runAutomationCycle(k.t.db, { now: new Date(at(10, 1).getTime() + (RETRY_SECONDS + 5) * 1000) });
    [step] = await stepRunsOf(c.campaignId);
    expect(step).toMatchObject({ status: 'completed', audio_id: drawn });
    expect(k.sends()).toHaveLength(2);
    // As duas tentativas levaram o MESMO áudio (os mesmos bytes).
    const [refused, delivered] = k.sends().map((call) => (call.body as { audio: string }).audio);
    expect(delivered).toBe(refused);
    // Um único sorteio foi gasto (sobraram 2 no saco), não dois.
    expect((await bagOf(`campaign:${c.campaignId}`))?.remaining).toHaveLength(2);
    expect(k.sends().map(instanceName)).toEqual(['whatsapp-01', 'whatsapp-01']);
  });

  it('etapa de áudio FIXO continua enviando sempre o mesmo áudio', async () => {
    const audios = await library(2);
    const chosen = audios[1] as (typeof audios)[number];
    const c = await campaign({
      leads: 6,
      audios,
      steps: () => [{ audio: chosen.id }],
      extra: { dailyLimitPerNumber: 3 },
    });
    await k.simulate({});
    const runs = await stepRunsOf(c.campaignId);
    expect(runs).toHaveLength(6);
    expect(runs.every((r) => r.audio_id === chosen.id)).toBe(true);
    expect(
      k.sends().every((call) => (call.body as { audio: string }).audio === chosen.bytes.toString('base64')),
    ).toBe(true);
    // O fixo não mexe no saco do sorteio.
    expect(await bagOf(`campaign:${c.campaignId}`)).toBeUndefined();
  });

  it('a etapa 2 (texto) de uma campanha com áudio sorteado na 1 não sorteia nada', async () => {
    const audios = await library(2);
    const c = await campaign({
      leads: 4,
      audios,
      numbers: [k.numbers[0]],
      steps: () => [{ audio: 'random' }, { text: 'Conseguiu ouvir?', delaySeconds: 600 }],
    });
    await k.simulate({ from: 600, to: 965 });
    const runs = await stepRunsOf(c.campaignId);
    expect(runs.filter((r) => r.audio_id !== null)).toHaveLength(4);
    expect(runs.filter((r) => r.audio_id === null)).toHaveLength(4);
    expect(k.fake.calls.filter((call) => call.url.startsWith('/message/sendText/'))).toHaveLength(4);
  });
});
