import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AutomationItem, AutomationStep } from '../../src/shared/api';
import { AUTOMATION_MAX_STEPS } from '../../src/shared/automations';
import { type FakeEvolution, startFakeEvolution } from '../fake-evolution';
import { Client, createTestApp, createUser, loginAs, seedList, type TestApp } from '../helpers';

// Etapas das automações pela API, no Postgres de testes. Só configuração: nada aqui envia mensagem,
// e a Evolution de mentira serve para provar que ela nunca é chamada.

let t: TestApp;
let fake: FakeEvolution;
let media: string;
let anonymous: Client;
let atendente: Client;
let supervisor: Client;
let admin: Client;
let counter = 0;

beforeAll(async () => {
  fake = await startFakeEvolution();
  media = mkdtempSync(join(tmpdir(), 'midias-automacoes-'));
  t = await createTestApp({
    env: {
      EVOLUTION_URL: fake.url,
      EVOLUTION_API_KEY: 'chave-teste',
      WEBHOOK_TOKEN: 'token-do-webhook-de-teste',
      MEDIA_DIR: media,
    },
  });
  atendente = await loginAs(t.app, await createUser(t.db, { name: 'Ana', role: 'atendente' }));
  supervisor = await loginAs(t.app, await createUser(t.db, { name: 'Sérgio', role: 'supervisor' }));
  admin = await loginAs(t.app, await createUser(t.db, { name: 'Gestora', role: 'admin' }));
  anonymous = new Client(t.app);
});
afterAll(async () => {
  await t?.close();
  await fake?.close();
  rmSync(media, { recursive: true, force: true });
});

// ---------- ajudantes ----------

async function newAutomation(): Promise<number> {
  counter += 1;
  const r = await admin.post('/api/automations', { name: `Automação de etapas ${counter}` });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as AutomationItem).id;
}

const text = (extra: Record<string, unknown> = {}) => ({
  actionType: 'send_text',
  delaySeconds: 0,
  messageText: 'Olá, {{nome}}! Tudo bem?',
  conditions: [],
  ...extra,
});
const audio = (audioId: number, extra: Record<string, unknown> = {}) => ({
  actionType: 'send_audio',
  delaySeconds: 3600,
  audioId,
  conditions: [],
  ...extra,
});

async function addStep(automationId: number, body: Record<string, unknown>): Promise<AutomationStep[]> {
  const r = await admin.post(`/api/automations/${automationId}/steps`, body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}

async function uploadAudio(label: string): Promise<number> {
  const r = await admin.request(
    'POST',
    `/api/audios?label=${encodeURIComponent(label)}&seconds=12`,
    Buffer.from(label),
    {
      'content-type': 'audio/ogg',
    },
  );
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id;
}

const stepsOf = async (automationId: number) =>
  (await admin.get(`/api/automations/${automationId}/steps`)).json() as AutomationStep[];
const positions = (steps: AutomationStep[]) => steps.map((s) => s.position);
const messagesOf = (steps: AutomationStep[]) => steps.map((s) => s.messageText);

const auditActions = async (automationId: number) =>
  (
    await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('entity', '=', 'automacao')
      .where('entity_id', '=', String(automationId))
      .orderBy('id')
      .execute()
  ).map((row) => row.action);

const dbPositions = async (automationId: number) =>
  (
    await t.db
      .selectFrom('automation_steps')
      .select('position')
      .where('automation_id', '=', automationId)
      .orderBy('position')
      .execute()
  ).map((row) => row.position);

// ---------- acesso ----------

describe('etapas: acesso', () => {
  it('sem login 401; atendente e supervisor 403 em todas as rotas de etapas, e nada muda', async () => {
    const id = await newAutomation();
    const [step] = await addStep(id, text());
    const calls: [string, string, unknown?][] = [
      ['GET', `/api/automations/${id}/steps`],
      ['POST', `/api/automations/${id}/steps`, text()],
      ['PATCH', `/api/automations/${id}/steps/${step?.id}`, { delaySeconds: 60 }],
      ['DELETE', `/api/automations/${id}/steps/${step?.id}`],
      ['POST', `/api/automations/${id}/steps/reorder`, { stepIds: [step?.id] }],
    ];
    for (const [method, url, body] of calls) {
      expect(
        (await anonymous.request(method as 'GET', url, body)).statusCode,
        `sem login ${method} ${url}`,
      ).toBe(401);
      for (const who of [atendente, supervisor]) {
        expect((await who.request(method as 'GET', url, body)).statusCode, `${method} ${url}`).toBe(403);
      }
    }
    expect(await stepsOf(id)).toEqual([step]);
  });
});

// ---------- criar e listar ----------

describe('etapas: criar e listar', () => {
  it('cria etapas no fim, com espera, texto e condições, e lista na ordem', async () => {
    const id = await newAutomation();
    const first = await addStep(id, text());
    expect(first).toEqual([
      {
        id: expect.any(Number),
        position: 1,
        actionType: 'send_text',
        delaySeconds: 0,
        messageText: 'Olá, {{nome}}! Tudo bem?',
        audioId: null,
        audioMode: 'fixed',
        conditions: [],
      },
    ]);
    const second = await addStep(
      id,
      text({
        delaySeconds: 7200,
        messageText: 'Conseguiu verificar nossa mensagem?',
        conditions: [{ field: 'lead_replied', operator: 'is', value: false }],
      }),
    );
    expect(positions(second)).toEqual([1, 2]);
    expect(second[1]).toMatchObject({
      delaySeconds: 7200,
      conditions: [{ field: 'lead_replied', operator: 'is', value: false }],
    });

    expect(await stepsOf(id)).toEqual(second);
    const automation = (await admin.get(`/api/automations/${id}`)).json() as AutomationItem;
    expect(automation.steps).toEqual(second);
    expect(await auditActions(id)).toEqual([
      'criou_automacao',
      'criou_etapa_automacao',
      'criou_etapa_automacao',
    ]);
  });

  it('as variáveis {{nome}} ficam guardadas como estão (nada é trocado no servidor)', async () => {
    const id = await newAutomation();
    const message = 'Oi {{nome}}, da {{empresa}} ({{telefone}}). Sou {{atendente}}, pelo {{numero}}.';
    const [step] = await addStep(id, text({ messageText: message }));
    expect(step?.messageText).toBe(message);
  });

  it('insere numa posição: as seguintes descem, sem repetir posição', async () => {
    const id = await newAutomation();
    await addStep(id, text({ messageText: 'A' }));
    await addStep(id, text({ messageText: 'B' }));
    const steps = await addStep(id, text({ messageText: 'C', position: 1 }));
    expect(messagesOf(steps)).toEqual(['C', 'A', 'B']);
    expect(positions(steps)).toEqual([1, 2, 3]);
    expect(await dbPositions(id)).toEqual([1, 2, 3]);
    const middle = await addStep(id, text({ messageText: 'D', position: 3 }));
    expect(messagesOf(middle)).toEqual(['C', 'A', 'D', 'B']);
  });

  it('posição fora do intervalo responde 400', async () => {
    const id = await newAutomation();
    await addStep(id, text());
    for (const position of [0, -1, 3, 50]) {
      const r = await admin.post(`/api/automations/${id}/steps`, text({ position }));
      expect(r.statusCode, String(position)).toBe(400);
    }
    expect(await dbPositions(id)).toEqual([1]);
  });

  it(`uma automação tem no máximo ${AUTOMATION_MAX_STEPS} etapas`, async () => {
    const id = await newAutomation();
    for (let i = 0; i < AUTOMATION_MAX_STEPS; i++) await addStep(id, text({ messageText: `Etapa ${i + 1}` }));
    const r = await admin.post(`/api/automations/${id}/steps`, text());
    expect(r.statusCode).toBe(409);
    expect(await dbPositions(id)).toHaveLength(AUTOMATION_MAX_STEPS);
  });

  it('mexer nas etapas atualiza a data de alteração da automação', async () => {
    const id = await newAutomation();
    const before = (await admin.get(`/api/automations/${id}`)).json() as AutomationItem;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await addStep(id, text());
    const after = (await admin.get(`/api/automations/${id}`)).json() as AutomationItem;
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
  });
});

// ---------- validação de texto e áudio ----------

describe('etapas: texto e áudio', () => {
  it('etapa de texto sem mensagem é recusada (400)', async () => {
    const id = await newAutomation();
    for (const messageText of [undefined, null, '', '   ']) {
      const r = await admin.post(`/api/automations/${id}/steps`, text({ messageText }));
      expect(r.statusCode, JSON.stringify(messageText)).toBe(400);
    }
    const noText = await admin.post(`/api/automations/${id}/steps`, {
      actionType: 'send_text',
      delaySeconds: 0,
      conditions: [],
    });
    expect(noText.statusCode).toBe(400);
    expect(noText.json().error).toContain('Mensagem');
    expect(await dbPositions(id)).toEqual([]);
  });

  it('mensagem de mais de 4096 letras é recusada; com 4096 passa', async () => {
    const id = await newAutomation();
    expect(
      (await admin.post(`/api/automations/${id}/steps`, text({ messageText: 'x'.repeat(4097) }))).statusCode,
    ).toBe(400);
    expect(
      (await admin.post(`/api/automations/${id}/steps`, text({ messageText: 'x'.repeat(4096) }))).statusCode,
    ).toBe(201);
  });

  it('etapa de áudio sem áudio, ou com áudio que não existe, é recusada (400)', async () => {
    const id = await newAutomation();
    for (const body of [
      { actionType: 'send_audio', delaySeconds: 0, conditions: [] },
      { actionType: 'send_audio', delaySeconds: 0, audioId: null, conditions: [] },
      audio(999_999),
    ]) {
      const r = await admin.post(`/api/automations/${id}/steps`, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await dbPositions(id)).toEqual([]);
  });

  it('etapa de áudio guarda o áudio da biblioteca e não guarda texto', async () => {
    const id = await newAutomation();
    const audioId = await uploadAudio('Apresentação');
    const steps = await addStep(id, audio(audioId, { messageText: 'isto não deve ser guardado' }));
    expect(steps[0]).toMatchObject({
      actionType: 'send_audio',
      audioId,
      messageText: null,
      delaySeconds: 3600,
    });
  });

  it('a etapa de texto não guarda áudio', async () => {
    const id = await newAutomation();
    const audioId = await uploadAudio('Sobrando');
    const steps = await addStep(id, text({ audioId }));
    expect(steps[0]).toMatchObject({ actionType: 'send_text', audioId: null });
  });

  it('espera inválida é recusada; 0 é imediatamente; o máximo é 1 ano', async () => {
    const id = await newAutomation();
    for (const delaySeconds of [-1, 1.5, 31_536_001, '60', null]) {
      const r = await admin.post(`/api/automations/${id}/steps`, text({ delaySeconds }));
      expect(r.statusCode, JSON.stringify(delaySeconds)).toBe(400);
    }
    const steps = await addStep(id, text({ delaySeconds: 0 }));
    expect(steps[0]?.delaySeconds).toBe(0);
    const year = await addStep(id, text({ delaySeconds: 31_536_000 }));
    expect(year[1]?.delaySeconds).toBe(31_536_000);
  });

  it('tipo de ação desconhecido é recusado', async () => {
    const id = await newAutomation();
    expect(
      (await admin.post(`/api/automations/${id}/steps`, text({ actionType: 'send_video' }))).statusCode,
    ).toBe(400);
    expect((await admin.post(`/api/automations/${id}/steps`, {})).statusCode).toBe(400);
  });
});

// ---------- condições ----------

describe('etapas: condições (só guardadas)', () => {
  it('guarda os quatro tipos de condição no formato { field, operator, value }', async () => {
    const id = await newAutomation();
    const listId = (await seedList(t.db, { count: 1 })).listId;
    const conditions = [
      { field: 'lead_result', operator: 'is', value: 'respondeu' },
      { field: 'lead_replied', operator: 'is_not', value: true },
      { field: 'lead_status', operator: 'is', value: 'chamado' },
      { field: 'lead_list', operator: 'is', value: listId },
    ];
    const steps = await addStep(id, text({ conditions }));
    expect(steps[0]?.conditions).toEqual(conditions);
    const row = await t.db
      .selectFrom('automation_steps')
      .select('conditions')
      .where('automation_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.conditions).toEqual(conditions);
  });

  it('recusa condição malformada (400)', async () => {
    const id = await newAutomation();
    const bad: unknown[] = [
      [{ field: 'lead_result', operator: 'is', value: 'nao_existe' }],
      [{ field: 'lead_result', operator: 'is', value: true }],
      [{ field: 'lead_replied', operator: 'is', value: 'sim' }],
      [{ field: 'lead_status', operator: 'is', value: 'perdido' }],
      [{ field: 'lead_list', operator: 'is', value: 'não-é-uuid' }],
      [{ field: 'lead_owner', operator: 'is', value: 'x' }],
      [{ field: 'lead_result', operator: 'contains', value: 'respondeu' }],
      [{ field: 'lead_replied', operator: 'is', value: true, extra: 1 }],
      [{ type: 'lead_not_replied' }], // formato antigo, sem campo/operador/valor
      'lead_replied',
    ];
    for (const conditions of bad) {
      const r = await admin.post(`/api/automations/${id}/steps`, text({ conditions }));
      expect(r.statusCode, JSON.stringify(conditions)).toBe(400);
    }
    expect(await dbPositions(id)).toEqual([]);
  });

  it('a lista de uma condição precisa existir', async () => {
    const id = await newAutomation();
    const r = await admin.post(
      `/api/automations/${id}/steps`,
      text({
        conditions: [{ field: 'lead_list', operator: 'is', value: '00000000-0000-4000-8000-000000000000' }],
      }),
    );
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('lista');
  });

  it('no máximo 10 condições por etapa', async () => {
    const id = await newAutomation();
    const one = { field: 'lead_replied', operator: 'is', value: false };
    expect(
      (await admin.post(`/api/automations/${id}/steps`, text({ conditions: Array(11).fill(one) })))
        .statusCode,
    ).toBe(400);
    expect(
      (await admin.post(`/api/automations/${id}/steps`, text({ conditions: Array(10).fill(one) })))
        .statusCode,
    ).toBe(201);
  });
});

// ---------- editar ----------

describe('etapas: editar', () => {
  it('muda só o que foi enviado e devolve a lista', async () => {
    const id = await newAutomation();
    const [step] = await addStep(id, text({ messageText: 'Original', delaySeconds: 60 }));
    const r = await admin.patch(`/api/automations/${id}/steps/${step?.id}`, { delaySeconds: 7200 });
    expect(r.statusCode, r.body).toBe(200);
    const [changed] = r.json() as AutomationStep[];
    expect(changed).toEqual({ ...step, delaySeconds: 7200 });

    const text2 = (
      await admin.patch(`/api/automations/${id}/steps/${step?.id}`, { messageText: 'Novo texto' })
    ).json();
    expect(text2[0]).toMatchObject({ messageText: 'Novo texto', delaySeconds: 7200 });
    expect(await auditActions(id)).toEqual([
      'criou_automacao',
      'criou_etapa_automacao',
      'alterou_etapa_automacao',
      'alterou_etapa_automacao',
    ]);
  });

  it('trocar de texto para áudio exige o áudio; de áudio para texto exige a mensagem', async () => {
    const id = await newAutomation();
    const audioId = await uploadAudio('Troca');
    const [step] = await addStep(id, text({ messageText: 'Texto que vai sumir' }));
    const url = `/api/automations/${id}/steps/${step?.id}`;

    expect((await admin.patch(url, { actionType: 'send_audio' })).statusCode).toBe(400);
    const toAudio = await admin.patch(url, { actionType: 'send_audio', audioId });
    expect(toAudio.statusCode, toAudio.body).toBe(200);
    expect(toAudio.json()[0]).toMatchObject({ actionType: 'send_audio', audioId, messageText: null });

    expect((await admin.patch(url, { actionType: 'send_text' })).statusCode).toBe(400);
    const toText = await admin.patch(url, { actionType: 'send_text', messageText: 'Voltou o texto' });
    expect(toText.statusCode, toText.body).toBe(200);
    expect(toText.json()[0]).toMatchObject({
      actionType: 'send_text',
      audioId: null,
      messageText: 'Voltou o texto',
    });
  });

  it('não deixa a etapa de texto ficar sem mensagem, nem a de áudio sem áudio', async () => {
    const id = await newAutomation();
    const audioId = await uploadAudio('Fixo');
    await addStep(id, text());
    await addStep(id, audio(audioId));
    const all = await stepsOf(id);
    const [t1, t2] = all;
    expect(
      (await admin.patch(`/api/automations/${id}/steps/${t1?.id}`, { messageText: null })).statusCode,
    ).toBe(400);
    expect(
      (await admin.patch(`/api/automations/${id}/steps/${t1?.id}`, { messageText: '   ' })).statusCode,
    ).toBe(400);
    expect((await admin.patch(`/api/automations/${id}/steps/${t2?.id}`, { audioId: null })).statusCode).toBe(
      400,
    );
    expect(
      (await admin.patch(`/api/automations/${id}/steps/${t2?.id}`, { audioId: 999_999 })).statusCode,
    ).toBe(400);
    expect(await stepsOf(id)).toEqual(all);
  });

  it('atualiza as condições e recusa condição inválida', async () => {
    const id = await newAutomation();
    const [step] = await addStep(id, text());
    const url = `/api/automations/${id}/steps/${step?.id}`;
    const conditions = [{ field: 'lead_result', operator: 'is', value: 'interessado' }];
    expect((await admin.patch(url, { conditions })).json()[0].conditions).toEqual(conditions);
    expect(
      (await admin.patch(url, { conditions: [{ field: 'x', operator: 'is', value: 1 }] })).statusCode,
    ).toBe(400);
    expect((await admin.patch(url, { conditions: [] })).json()[0].conditions).toEqual([]);
  });

  it('sem nenhum campo, responde 400; sem mudança de verdade, não grava nem audita', async () => {
    const id = await newAutomation();
    const [step] = await addStep(id, text());
    const url = `/api/automations/${id}/steps/${step?.id}`;
    expect((await admin.patch(url, {})).statusCode).toBe(400);
    const same = await admin.patch(url, { delaySeconds: step?.delaySeconds, messageText: step?.messageText });
    expect(same.statusCode).toBe(200);
    expect(await auditActions(id)).toEqual(['criou_automacao', 'criou_etapa_automacao']);
  });

  it('a posição não muda por aqui (só pela reordenação)', async () => {
    const id = await newAutomation();
    const [first] = await addStep(id, text({ messageText: 'A' }));
    await addStep(id, text({ messageText: 'B' }));
    const r = await admin.patch(`/api/automations/${id}/steps/${first?.id}`, {
      position: 2,
      delaySeconds: 5,
    });
    expect(positions(r.json())).toEqual([1, 2]);
    expect(messagesOf(r.json())).toEqual(['A', 'B']);
  });
});

// ---------- excluir ----------

describe('etapas: excluir', () => {
  it('exclui a etapa e as seguintes sobem uma posição', async () => {
    const id = await newAutomation();
    await addStep(id, text({ messageText: 'A' }));
    const [, second] = await addStep(id, text({ messageText: 'B' }));
    await addStep(id, text({ messageText: 'C' }));
    const r = await admin.delete(`/api/automations/${id}/steps/${second?.id}`);
    expect(r.statusCode, r.body).toBe(200);
    const left = r.json() as AutomationStep[];
    expect(messagesOf(left)).toEqual(['A', 'C']);
    expect(positions(left)).toEqual([1, 2]);
    expect(await dbPositions(id)).toEqual([1, 2]);
    expect(await auditActions(id)).toContain('excluiu_etapa_automacao');
  });

  it('automação ativa não perde a última etapa; pausada perde', async () => {
    const id = await newAutomation();
    const [only] = await addStep(id, text());
    expect((await admin.patch(`/api/automations/${id}/status`, { status: 'active' })).statusCode).toBe(200);
    const blocked = await admin.delete(`/api/automations/${id}/steps/${only?.id}`);
    expect(blocked.statusCode).toBe(409);
    expect(await stepsOf(id)).toHaveLength(1);

    await admin.patch(`/api/automations/${id}/status`, { status: 'paused' });
    expect((await admin.delete(`/api/automations/${id}/steps/${only?.id}`)).statusCode).toBe(200);
    expect(await stepsOf(id)).toEqual([]);
  });

  it('excluir uma etapa que já tem histórico de execução mantém o histórico (sem o vínculo)', async () => {
    const id = await newAutomation();
    const [step] = await addStep(id, text());
    const list = await seedList(t.db, { count: 1 });
    const lead = list.leadIds[0] as number;
    const run = await t.db
      .insertInto('automation_runs')
      .values({ automation_id: id, lead_id: lead })
      .returning('id')
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('automation_step_runs')
      .values({ automation_run_id: run.id, step_id: step?.id, scheduled_at: new Date() })
      .execute();
    expect((await admin.delete(`/api/automations/${id}/steps/${step?.id}`)).statusCode).toBe(200);
    const kept = await t.db
      .selectFrom('automation_step_runs')
      .select('step_id')
      .where('automation_run_id', '=', run.id)
      .execute();
    expect(kept).toEqual([{ step_id: null }]);
  });
});

// ---------- reordenar ----------

describe('etapas: reordenar', () => {
  it('salva a nova ordem e devolve a lista na ordem nova', async () => {
    const id = await newAutomation();
    const [a] = await addStep(id, text({ messageText: 'A' }));
    const [, b] = await addStep(id, text({ messageText: 'B' }));
    const [, , c] = await addStep(id, text({ messageText: 'C' }));
    const r = await admin.post(`/api/automations/${id}/steps/reorder`, { stepIds: [c?.id, a?.id, b?.id] });
    expect(r.statusCode, r.body).toBe(200);
    expect(messagesOf(r.json())).toEqual(['C', 'A', 'B']);
    expect(positions(r.json())).toEqual([1, 2, 3]);
    expect(messagesOf(await stepsOf(id))).toEqual(['C', 'A', 'B']);
    expect(await dbPositions(id)).toEqual([1, 2, 3]);
    expect(await auditActions(id)).toContain('reordenou_etapas_automacao');
  });

  it('trocar duas etapas de lugar (subir/descer) funciona', async () => {
    const id = await newAutomation();
    const [a] = await addStep(id, text({ messageText: 'A' }));
    const [, b] = await addStep(id, text({ messageText: 'B' }));
    const r = await admin.post(`/api/automations/${id}/steps/reorder`, { stepIds: [b?.id, a?.id] });
    expect(messagesOf(r.json())).toEqual(['B', 'A']);
  });

  it('a mesma ordem não grava nem audita', async () => {
    const id = await newAutomation();
    const [a] = await addStep(id, text({ messageText: 'A' }));
    const [, b] = await addStep(id, text({ messageText: 'B' }));
    const r = await admin.post(`/api/automations/${id}/steps/reorder`, { stepIds: [a?.id, b?.id] });
    expect(r.statusCode).toBe(200);
    expect(await auditActions(id)).not.toContain('reordenou_etapas_automacao');
  });

  it('não confia na tela: repetida, faltando, sobrando ou desconhecida responde 400 e nada muda', async () => {
    const id = await newAutomation();
    const [a] = await addStep(id, text({ messageText: 'A' }));
    const [, b] = await addStep(id, text({ messageText: 'B' }));
    const url = `/api/automations/${id}/steps/reorder`;
    const before = await stepsOf(id);
    for (const stepIds of [
      [a?.id, a?.id],
      [a?.id],
      [a?.id, b?.id, 999_999],
      [a?.id, 999_999],
      [],
      ['1', '2'],
    ]) {
      expect((await admin.post(url, { stepIds })).statusCode, JSON.stringify(stepIds)).toBe(400);
    }
    expect((await admin.post(url, {})).statusCode).toBe(400);
    expect(await stepsOf(id)).toEqual(before);
  });
});

// ---------- automação inexistente, arquivada e de outra automação ----------

describe('etapas: automação inexistente', () => {
  it('todas as rotas respondem 404', async () => {
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/automations/999999/steps'],
      ['POST', '/api/automations/999999/steps', text()],
      ['PATCH', '/api/automations/999999/steps/1', { delaySeconds: 1 }],
      ['DELETE', '/api/automations/999999/steps/1'],
      ['POST', '/api/automations/999999/steps/reorder', { stepIds: [1] }],
      ['GET', '/api/automations/abc/steps'],
      ['PATCH', '/api/automations/1/steps/abc', { delaySeconds: 1 }],
      ['DELETE', '/api/automations/1/steps/0'],
    ];
    for (const [method, url, body] of calls) {
      expect((await admin.request(method as 'GET', url, body)).statusCode, `${method} ${url}`).toBe(404);
    }
    const none = await t.db
      .selectFrom('automation_steps')
      .select('id')
      .where('automation_id', '=', 999_999)
      .execute();
    expect(none).toEqual([]);
  });
});

describe('etapas: automação arquivada', () => {
  it('não recebe, altera, perde nem reordena etapas (409), mas as etapas continuam visíveis', async () => {
    const id = await newAutomation();
    const audioId = await uploadAudio('Arquivada');
    await addStep(id, text({ messageText: 'A' }));
    await addStep(id, audio(audioId));
    const before = await stepsOf(id);
    expect((await admin.post(`/api/automations/${id}/archive`)).statusCode).toBe(200);

    const [first, second] = before;
    const calls: [string, string, unknown?][] = [
      ['POST', `/api/automations/${id}/steps`, text()],
      ['PATCH', `/api/automations/${id}/steps/${first?.id}`, { delaySeconds: 99 }],
      ['DELETE', `/api/automations/${id}/steps/${first?.id}`],
      ['POST', `/api/automations/${id}/steps/reorder`, { stepIds: [second?.id, first?.id] }],
    ];
    for (const [method, url, body] of calls) {
      const r = await admin.request(method as 'GET', url, body);
      expect(r.statusCode, `${method} ${url}`).toBe(409);
      expect(r.json().error).toContain('arquivada');
    }
    expect(await stepsOf(id)).toEqual(before);
    expect(((await admin.get(`/api/automations/${id}`)).json() as AutomationItem).steps).toEqual(before);
  });
});

describe('etapas: etapa de outra automação', () => {
  it('não dá para ver, alterar, excluir nem reordenar pela automação errada', async () => {
    const a = await newAutomation();
    const b = await newAutomation();
    const [stepOfA] = await addStep(a, text({ messageText: 'Da A' }));
    const [stepOfB] = await addStep(b, text({ messageText: 'Da B' }));
    const beforeB = await stepsOf(b);

    // PATCH e DELETE da etapa de B pelo caminho de A: 404 (não revela que existe).
    expect(
      (await admin.patch(`/api/automations/${a}/steps/${stepOfB?.id}`, { delaySeconds: 1 })).statusCode,
    ).toBe(404);
    expect((await admin.delete(`/api/automations/${a}/steps/${stepOfB?.id}`)).statusCode).toBe(404);
    // Reordenar A com o id da etapa de B: 400.
    const reorder = await admin.post(`/api/automations/${a}/steps/reorder`, { stepIds: [stepOfB?.id] });
    expect(reorder.statusCode).toBe(400);

    expect(await stepsOf(b)).toEqual(beforeB);
    expect(messagesOf(await stepsOf(a))).toEqual(['Da A']);
    expect(stepOfA?.id).not.toBe(stepOfB?.id);
  });
});

// ---------- posições ----------

describe('etapas: posições no banco', () => {
  it('o banco não aceita duas etapas na mesma posição da mesma automação', async () => {
    const id = await newAutomation();
    await addStep(id, text());
    const dup = t.db
      .insertInto('automation_steps')
      .values({ automation_id: id, position: 1, action_type: 'send_text', message_text: 'duplicada' })
      .execute();
    await expect(dup).rejects.toMatchObject({ code: '23505' });
    expect(await dbPositions(id)).toEqual([1]);
  });

  it('criar, excluir e reordenar em sequência mantém as posições 1..n sem buracos', async () => {
    const id = await newAutomation();
    for (const label of ['A', 'B', 'C', 'D']) await addStep(id, text({ messageText: label }));
    const steps = await stepsOf(id); // A B C D
    await admin.delete(`/api/automations/${id}/steps/${steps[1]?.id}`); // A C D
    await addStep(id, text({ messageText: 'E', position: 2 })); // A E C D
    const now = await stepsOf(id);
    await admin.post(`/api/automations/${id}/steps/reorder`, { stepIds: now.map((s) => s.id).reverse() });
    expect(await dbPositions(id)).toEqual([1, 2, 3, 4]);
    expect(messagesOf(await stepsOf(id))).toEqual(['D', 'C', 'E', 'A']);
  });
});

// ---------- ativar ----------

describe('etapas: ativar a automação', () => {
  it('sem nenhuma etapa não ativa (409)', async () => {
    const id = await newAutomation();
    const r = await admin.patch(`/api/automations/${id}/status`, { status: 'active' });
    expect(r.statusCode).toBe(409);
    expect(r.json().problems).toEqual(['Adicione pelo menos uma etapa.']);
    expect(((await admin.get(`/api/automations/${id}`)).json() as AutomationItem).status).toBe('draft');
  });

  it('com etapa inválida não ativa (409); depois de corrigir, ativa', async () => {
    const id = await newAutomation();
    const audioId = await uploadAudio('Vai ser excluído');
    await addStep(id, text());
    await addStep(id, audio(audioId));

    // O áudio é excluído da biblioteca: a etapa continua, mas sem áudio (SET NULL).
    expect((await admin.post(`/api/audios/${audioId}/delete`)).statusCode).toBe(204);
    const steps = await stepsOf(id);
    expect(steps[1]).toMatchObject({ actionType: 'send_audio', audioId: null });

    const r = await admin.patch(`/api/automations/${id}/status`, { status: 'active' });
    expect(r.statusCode).toBe(409);
    expect(r.json().problems).toEqual(['Etapa 2: escolha o áudio.']);
    expect(r.json().error).toContain('Etapa 2');
    expect(((await admin.get(`/api/automations/${id}`)).json() as AutomationItem).status).toBe('draft');

    const newAudio = await uploadAudio('Substituto');
    expect(
      (await admin.patch(`/api/automations/${id}/steps/${steps[1]?.id}`, { audioId: newAudio })).statusCode,
    ).toBe(200);
    const ok = await admin.patch(`/api/automations/${id}/status`, { status: 'active' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe('active');
  });

  it('pausada com etapa inválida também não volta a ativar', async () => {
    const id = await newAutomation();
    const audioId = await uploadAudio('Some depois');
    await addStep(id, audio(audioId));
    expect((await admin.patch(`/api/automations/${id}/status`, { status: 'active' })).statusCode).toBe(200);
    await admin.patch(`/api/automations/${id}/status`, { status: 'paused' });
    await admin.post(`/api/audios/${audioId}/delete`);
    expect((await admin.patch(`/api/automations/${id}/status`, { status: 'active' })).statusCode).toBe(409);
  });

  it('a automação continua existindo quando o áudio da etapa é excluído', async () => {
    const id = await newAutomation();
    const audioId = await uploadAudio('Excluído');
    await addStep(id, audio(audioId));
    await admin.post(`/api/audios/${audioId}/delete`);
    const automation = (await admin.get(`/api/automations/${id}`)).json() as AutomationItem;
    expect(automation.steps).toHaveLength(1);
    expect(automation.steps[0]?.audioId).toBeNull();
  });
});

// ---------- nada é executado ----------

describe('automação ativa não executa nada', () => {
  // Outros testes deste arquivo criam histórico de execução de propósito: por isso se compara antes e depois.
  const snapshot = async () => {
    const total = async (table: 'automation_runs' | 'automation_step_runs' | 'wa_messages') =>
      Number(
        (
          await t.db
            .selectFrom(table)
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      );
    return {
      runs: await total('automation_runs'),
      stepRuns: await total('automation_step_runs'),
      messages: await total('wa_messages'),
      evolutionCalls: fake.calls.length,
    };
  };

  it('ativar e editar não criam participações, não enviam mensagem e não chamam a Evolution', async () => {
    const id = await newAutomation();
    const audioId = await uploadAudio('Sem envio');
    await addStep(id, text({ messageText: 'Olá, {{nome}}!' }));
    await addStep(id, text({ delaySeconds: 7200, messageText: 'Conseguiu ver?' }));
    await addStep(id, audio(audioId, { delaySeconds: 86_400 }));
    const list = await seedList(t.db, { count: 3, phoneStart: 500 });
    expect(list.leadIds).toHaveLength(3);
    const before = await snapshot();

    expect((await admin.patch(`/api/automations/${id}/status`, { status: 'active' })).statusCode).toBe(200);
    const listed = (await admin.get('/api/automations')).json() as AutomationItem[];
    expect(listed.find((a) => a.id === id)?.status).toBe('active');
    await admin.patch(`/api/automations/${id}/steps/${(await stepsOf(id))[0]?.id}`, { delaySeconds: 30 });
    await admin.patch(`/api/automations/${id}/status`, { status: 'paused' });
    await admin.post(`/api/automations/${id}/archive`);

    expect(await snapshot()).toEqual(before);
    expect(fake.calls).toEqual([]);
  });
});

// ---------- áudio sorteado ----------

describe('etapas: áudio sorteado', () => {
  const randomAudio = (extra: Record<string, unknown> = {}) => ({
    actionType: 'send_audio',
    delaySeconds: 0,
    audioMode: 'random',
    conditions: [],
    ...extra,
  });

  it('cria a etapa de áudio sorteado: sem áudio fixo (o sorteio sai entre os ativos da biblioteca)', async () => {
    const id = await newAutomation();
    const steps = await addStep(id, randomAudio());
    expect(steps[0]).toMatchObject({
      actionType: 'send_audio',
      audioMode: 'random',
      audioId: null,
      messageText: null,
    });
    // Um áudio fixo enviado junto é descartado: no sorteio a etapa não guarda áudio.
    const fixed = await uploadAudio('Fixo que será descartado');
    const withFixed = await addStep(id, randomAudio({ audioId: fixed }));
    expect(withFixed[1]).toMatchObject({ audioMode: 'random', audioId: null });
    expect(await stepsOf(id)).toEqual(withFixed);
  });

  it('o modo fixo continua exigindo o áudio; modo inválido é recusado; texto nunca sorteia', async () => {
    const id = await newAutomation();
    expect(
      (await admin.post(`/api/automations/${id}/steps`, audio(0, { audioId: undefined }))).statusCode,
    ).toBe(400);
    expect(
      (await admin.post(`/api/automations/${id}/steps`, { ...randomAudio(), audioMode: 'aleatorio' }))
        .statusCode,
    ).toBe(400);
    const steps = await addStep(id, text({ audioMode: 'random' }));
    expect(steps[0]).toMatchObject({ actionType: 'send_text', audioMode: 'fixed', audioId: null });
    const fixedAudio = await uploadAudio('Áudio fixo');
    const fixed = await addStep(id, audio(fixedAudio));
    expect(fixed[1]).toMatchObject({ audioMode: 'fixed', audioId: fixedAudio });
    expect(await dbPositions(id)).toEqual([1, 2]);
  });

  it('editar: trocar para sorteio limpa o áudio fixo; voltar para fixo exige escolher o áudio', async () => {
    const id = await newAutomation();
    const chosen = await uploadAudio('Escolhido');
    const [step] = await addStep(id, audio(chosen));
    const toRandom = await admin.patch(`/api/automations/${id}/steps/${step?.id}`, { audioMode: 'random' });
    expect(toRandom.statusCode, toRandom.body).toBe(200);
    expect(toRandom.json()[0]).toMatchObject({ audioMode: 'random', audioId: null });

    const back = await admin.patch(`/api/automations/${id}/steps/${step?.id}`, { audioMode: 'fixed' });
    expect(back.statusCode).toBe(400);
    expect(back.json().error).toMatch(/áudio/);
    const ok = await admin.patch(`/api/automations/${id}/steps/${step?.id}`, {
      audioMode: 'fixed',
      audioId: chosen,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()[0]).toMatchObject({ audioMode: 'fixed', audioId: chosen });
    // Trocar o tipo da ação para texto zera o modo e o áudio.
    const toText = await admin.patch(`/api/automations/${id}/steps/${step?.id}`, {
      actionType: 'send_text',
      messageText: 'Agora é texto',
    });
    expect(toText.statusCode, toText.body).toBe(200);
    expect(toText.json()[0]).toMatchObject({ actionType: 'send_text', audioMode: 'fixed', audioId: null });
    expect(await auditActions(id)).toEqual([
      'criou_automacao',
      'criou_etapa_automacao',
      'alterou_etapa_automacao',
      'alterou_etapa_automacao',
      'alterou_etapa_automacao',
    ]);
  });

  it('ativar: a etapa sorteada conta como completa, mas exige pelo menos um áudio ativo na biblioteca', async () => {
    await t.db.deleteFrom('wa_audios').execute();
    const id = await newAutomation();
    await addStep(id, randomAudio());
    const none = await admin.patch(`/api/automations/${id}/status`, { status: 'active' });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toMatch(/áudio ativo/);
    const library = await uploadAudio('Para o sorteio');
    await admin.patch(`/api/audios/${library}`, { active: false });
    expect((await admin.patch(`/api/automations/${id}/status`, { status: 'active' })).statusCode).toBe(409);
    await admin.patch(`/api/audios/${library}`, { active: true });
    const ok = await admin.patch(`/api/automations/${id}/status`, { status: 'active' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'active' });
  });

  it('o banco recusa sorteio numa etapa de texto e sorteio com áudio fixo guardado', async () => {
    const id = await newAutomation();
    const someAudio = await uploadAudio('Qualquer');
    const insert = (values: Record<string, unknown>) =>
      t.db
        .insertInto('automation_steps')
        .values({ automation_id: id, position: 1, ...values } as never)
        .execute();
    await expect(
      insert({ action_type: 'send_text', message_text: 'Oi', audio_mode: 'random' }),
    ).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      insert({ action_type: 'send_audio', audio_mode: 'random', audio_id: someAudio }),
    ).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      insert({ action_type: 'send_audio', audio_mode: 'talvez', audio_id: someAudio }),
    ).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert({ action_type: 'send_audio', audio_mode: 'random' })).resolves.toBeDefined();
  });
});
