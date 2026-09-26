import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AutomationItem } from '../../src/shared/api';
import { Client, createTestApp, createUser, loginAs, type TestApp } from '../helpers';

// CRUD da automação principal pela API, contra o Postgres de testes. Etapas, participações de leads e
// execução ainda não têm rota: aqui só se conferem as etapas que já vêm junto da automação (leitura).

let t: TestApp;
let anonymous: Client;
let atendente: Client;
let supervisor: Client;
let admin: Client;
let dono: Client;
let adminId: string;

beforeAll(async () => {
  t = await createTestApp();
  atendente = await loginAs(t.app, await createUser(t.db, { name: 'Ana', role: 'atendente' }));
  supervisor = await loginAs(t.app, await createUser(t.db, { name: 'Sérgio', role: 'supervisor' }));
  const gestora = await createUser(t.db, { name: 'Gestora', role: 'admin' });
  adminId = gestora.id;
  admin = await loginAs(t.app, gestora);
  dono = await loginAs(t.app, await createUser(t.db, { name: 'Dono', role: 'dono' }));
  anonymous = new Client(t.app);
});
afterAll(async () => t.close());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function create(who: Client, body: Record<string, unknown>): Promise<AutomationItem> {
  const r = await who.post('/api/automations', body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}

/** Uma etapa válida (texto): uma automação só ativa com pelo menos uma. */
async function addTextStep(id: number): Promise<void> {
  const r = await admin.post(`/api/automations/${id}/steps`, {
    actionType: 'send_text',
    delaySeconds: 0,
    messageText: 'Olá!',
    conditions: [],
  });
  expect(r.statusCode, r.body).toBe(201);
}

const auditActions = async (id: number) =>
  (
    await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('entity', '=', 'automacao')
      .where('entity_id', '=', String(id))
      .orderBy('id')
      .execute()
  ).map((row) => row.action);

describe('automações: acesso', () => {
  const calls: [method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown][] = [
    ['GET', '/api/automations'],
    ['GET', '/api/automations/1'],
    ['POST', '/api/automations', { name: 'Follow-up' }],
    ['PATCH', '/api/automations/1', { name: 'Novo nome' }],
    ['PATCH', '/api/automations/1/status', { status: 'active' }],
    ['POST', '/api/automations/1/archive'],
  ];

  it('sem login: 401 em todas as rotas', async () => {
    for (const [method, url, body] of calls) {
      expect((await anonymous.request(method, url, body)).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('atendente e supervisor: 403 em todas as rotas, e nada é criado', async () => {
    for (const who of [atendente, supervisor]) {
      for (const [method, url, body] of calls) {
        expect((await who.request(method, url, body)).statusCode, `${method} ${url}`).toBe(403);
      }
    }
    const rows = await t.db.selectFrom('automations').select('id').where('name', '=', 'Follow-up').execute();
    expect(rows).toEqual([]);
  });

  it('a tentativa negada fica na auditoria', async () => {
    const denied = await t.db
      .selectFrom('audit_log')
      .select('details')
      .where('action', '=', 'acesso_negado')
      .execute();
    expect(denied.some((row) => JSON.stringify(row.details).includes('/automations'))).toBe(true);
  });

  it('administrador e dono usam as rotas', async () => {
    for (const who of [admin, dono]) {
      expect((await who.get('/api/automations')).statusCode).toBe(200);
    }
  });
});

describe('automações: criar e buscar', () => {
  it('cria como rascunho, sem etapas, com gatilho manual quando não se escolhe outro', async () => {
    const a = await create(admin, { name: '  Follow-up de 24h  ' });
    expect(a).toMatchObject({
      name: 'Follow-up de 24h',
      description: null,
      status: 'draft',
      trigger: 'manual',
      steps: [],
      createdBy: { id: adminId, name: 'Gestora' },
    });
    expect(a.id).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(a.createdAt))).toBe(false);
    expect(a.updatedAt).toBe(a.createdAt);
    expect(await auditActions(a.id)).toEqual(['criou_automacao']);
  });

  it('guarda descrição e gatilho; o dono também cria', async () => {
    const a = await create(dono, {
      name: 'Retorno de quem não respondeu',
      description: 'Chama de novo depois de um dia',
      trigger: 'lead_called',
    });
    expect(a).toMatchObject({
      description: 'Chama de novo depois de um dia',
      trigger: 'lead_called',
      createdBy: { name: 'Dono' },
    });
  });

  it('não deixa dois nomes iguais entre as automações (sem diferenciar maiúsculas)', async () => {
    await create(admin, { name: 'Nome repetido' });
    for (const name of ['Nome repetido', 'NOME REPETIDO', '  nome repetido ']) {
      const r = await admin.post('/api/automations', { name });
      expect(r.statusCode, name).toBe(409);
      expect(r.json().code).toBe('conflito');
    }
  });

  it('busca uma automação pelo id; id que não existe responde 404', async () => {
    const a = await create(admin, { name: 'Para buscar' });
    const r = await admin.get(`/api/automations/${a.id}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(a);
    expect((await admin.get('/api/automations/999999')).statusCode).toBe(404);
  });
});

describe('automações: listar', () => {
  it('lista das mais novas para as mais antigas e não mostra as arquivadas', async () => {
    const first = await create(admin, { name: 'Lista A' });
    const second = await create(admin, { name: 'Lista B' });
    const archived = await create(admin, { name: 'Lista C arquivada' });
    expect((await admin.post(`/api/automations/${archived.id}/archive`)).statusCode).toBe(200);

    const r = await admin.get('/api/automations');
    expect(r.statusCode).toBe(200);
    const ids = (r.json() as AutomationItem[]).map((x) => x.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    expect(ids).not.toContain(archived.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
  });

  it('?archived=1 mostra só as arquivadas', async () => {
    const a = await create(admin, { name: 'Vai para o arquivo' });
    expect((await admin.post(`/api/automations/${a.id}/archive`)).statusCode).toBe(200);
    const list = (await admin.get('/api/automations?archived=1')).json() as AutomationItem[];
    expect(list.map((x) => x.id)).toContain(a.id);
    expect(list.every((x) => x.status === 'archived')).toBe(true);
    expect((await admin.get('/api/automations?archived=talvez')).statusCode).toBe(400);
  });
});

describe('automações: atualizar', () => {
  it('muda só o que foi enviado e apaga a descrição quando vem vazia', async () => {
    const a = await create(admin, { name: 'Para editar', description: 'Descrição antiga' });
    await sleep(5);
    const r = await admin.patch(`/api/automations/${a.id}`, { name: 'Editada', trigger: 'lead_created' });
    expect(r.statusCode, r.body).toBe(200);
    const updated: AutomationItem = r.json();
    expect(updated).toMatchObject({
      name: 'Editada',
      description: 'Descrição antiga',
      trigger: 'lead_created',
      status: 'draft',
    });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(a.updatedAt));
    expect(updated.createdAt).toBe(a.createdAt);

    const cleared = (await admin.patch(`/api/automations/${a.id}`, { description: '' })).json();
    expect(cleared.description).toBeNull();
    expect(cleared.name).toBe('Editada');
    expect(await auditActions(a.id)).toEqual(['criou_automacao', 'alterou_automacao', 'alterou_automacao']);
  });

  it('se nada mudou de verdade, não mexe no banco nem na auditoria', async () => {
    const a = await create(admin, { name: 'Sem mudança', description: 'igual' });
    const r = await admin.patch(`/api/automations/${a.id}`, { name: 'Sem mudança', description: 'igual' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(a);
    expect(await auditActions(a.id)).toEqual(['criou_automacao']);
  });

  it('não aceita o nome de outra automação, mas aceita mudar as maiúsculas do próprio nome', async () => {
    await create(admin, { name: 'Nome ocupado' });
    const mine = await create(admin, { name: 'Meu nome' });
    const clash = await admin.patch(`/api/automations/${mine.id}`, { name: 'nome OCUPADO' });
    expect(clash.statusCode).toBe(409);
    expect((await admin.get(`/api/automations/${mine.id}`)).json().name).toBe('Meu nome');
    const own = await admin.patch(`/api/automations/${mine.id}`, { name: 'MEU NOME' });
    expect(own.statusCode).toBe(200);
    expect(own.json().name).toBe('MEU NOME');
  });

  it('automação que não existe responde 404', async () => {
    expect((await admin.patch('/api/automations/999999', { name: 'x' })).statusCode).toBe(404);
  });
});

describe('automações: ativar, pausar e arquivar', () => {
  it('rascunho ativa, ativa pausa, pausada ativa de novo, e tudo fica na auditoria', async () => {
    const a = await create(admin, { name: 'Ciclo de vida' });
    await addTextStep(a.id);
    for (const status of ['active', 'paused', 'active'] as const) {
      const r = await admin.patch(`/api/automations/${a.id}/status`, { status });
      expect(r.statusCode, `${status}: ${r.body}`).toBe(200);
      expect(r.json().status).toBe(status);
    }
    expect(await auditActions(a.id)).toEqual([
      'criou_automacao',
      'criou_etapa_automacao',
      'ativou_automacao',
      'pausou_automacao',
      'ativou_automacao',
    ]);
  });

  it('recusa mudanças que a regra não permite, sem alterar nada (409)', async () => {
    const draft = await create(admin, { name: 'Ainda rascunho' });
    const toPaused = await admin.patch(`/api/automations/${draft.id}/status`, { status: 'paused' });
    expect(toPaused.statusCode).toBe(409);
    expect(toPaused.json().error).toContain('ativa pode ser pausada');

    await addTextStep(draft.id);
    expect((await admin.patch(`/api/automations/${draft.id}/status`, { status: 'active' })).statusCode).toBe(
      200,
    );
    const again = await admin.patch(`/api/automations/${draft.id}/status`, { status: 'active' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('já está ativa');
    expect((await admin.get(`/api/automations/${draft.id}`)).json().status).toBe('active');
  });

  it('arquivar guarda a data e não apaga nada; a automação continua podendo ser vista', async () => {
    const a = await create(admin, { name: 'Para arquivar' });
    const r = await admin.post(`/api/automations/${a.id}/archive`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id: a.id, name: 'Para arquivar', status: 'archived' });

    const row = await t.db
      .selectFrom('automations')
      .select(['status', 'archived_at'])
      .where('id', '=', a.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('archived');
    expect(row.archived_at).toBeInstanceOf(Date);
    expect((await admin.get(`/api/automations/${a.id}`)).json().status).toBe('archived');
    expect(await auditActions(a.id)).toEqual(['criou_automacao', 'arquivou_automacao']);
  });

  it('automação arquivada não pode ser alterada, ativada, pausada nem arquivada de novo (409)', async () => {
    const a = await create(admin, { name: 'Arquivada e trancada' });
    await admin.post(`/api/automations/${a.id}/archive`);

    const edit = await admin.patch(`/api/automations/${a.id}`, { name: 'Outro nome' });
    expect(edit.statusCode).toBe(409);
    for (const status of ['active', 'paused']) {
      const r = await admin.patch(`/api/automations/${a.id}/status`, { status });
      expect(r.statusCode, status).toBe(409);
      expect(r.json().error).toContain('arquivada');
    }
    expect((await admin.post(`/api/automations/${a.id}/archive`)).statusCode).toBe(409);

    const after = (await admin.get(`/api/automations/${a.id}`)).json();
    expect(after.status).toBe('archived');
    expect(after.name).toBe('Arquivada e trancada');
    // Nada disso entrou na auditoria como sucesso.
    expect(await auditActions(a.id)).toEqual(['criou_automacao', 'arquivou_automacao']);
  });

  it('arquivar libera o nome para uma automação nova', async () => {
    const old = await create(admin, { name: 'Nome reaproveitado' });
    expect((await admin.post('/api/automations', { name: 'Nome reaproveitado' })).statusCode).toBe(409);
    await admin.post(`/api/automations/${old.id}/archive`);
    const fresh = await create(admin, { name: 'Nome reaproveitado' });
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.status).toBe('draft');
  });

  it('automação que não existe responde 404', async () => {
    expect((await admin.patch('/api/automations/999999/status', { status: 'active' })).statusCode).toBe(404);
    expect((await admin.post('/api/automations/999999/archive')).statusCode).toBe(404);
  });
});

describe('automações: etapas vêm junto da automação (leitura)', () => {
  it('traz as etapas na ordem, com ação, atraso e condições', async () => {
    const a = await create(admin, { name: 'Com etapas' });
    await t.db
      .insertInto('automation_steps')
      .values([
        {
          automation_id: a.id,
          position: 2,
          action_type: 'send_audio',
          delay_seconds: 3600,
          message_text: null,
          conditions: JSON.stringify([{ field: 'lead_replied', operator: 'is', value: false }]),
        },
        {
          automation_id: a.id,
          position: 1,
          action_type: 'send_text',
          message_text: 'Olá! Posso ajudar?',
          conditions: JSON.stringify([]),
        },
      ])
      .execute();

    const r = await admin.get(`/api/automations/${a.id}`);
    const steps = (r.json() as AutomationItem).steps;
    expect(steps.map((s) => s.position)).toEqual([1, 2]);
    expect(steps[0]).toMatchObject({
      delaySeconds: 0,
      actionType: 'send_text',
      messageText: 'Olá! Posso ajudar?',
      audioId: null,
      conditions: [],
    });
    expect(steps[1]).toMatchObject({
      delaySeconds: 3600,
      actionType: 'send_audio',
      messageText: null,
      audioId: null,
      conditions: [{ field: 'lead_replied', operator: 'is', value: false }],
    });

    const listed = ((await admin.get('/api/automations')).json() as AutomationItem[]).find(
      (x) => x.id === a.id,
    );
    expect(listed?.steps).toHaveLength(2);
  });
});

describe('automações: validação', () => {
  it('criar sem nome ou com gatilho inválido responde 400', async () => {
    for (const body of [{}, { name: '   ' }, { name: 'A', trigger: 'nada' }, { name: 'x'.repeat(81) }]) {
      const r = await admin.post('/api/automations', body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().code).toBe('requisicao_invalida');
    }
  });

  it('atualizar sem nenhum campo, ou com campo inválido, responde 400', async () => {
    const a = await create(admin, { name: 'Validação' });
    for (const body of [{}, { name: '' }, { trigger: 'nada' }]) {
      expect((await admin.patch(`/api/automations/${a.id}`, body)).statusCode, JSON.stringify(body)).toBe(
        400,
      );
    }
  });

  it('a situação só aceita ativar ou pausar', async () => {
    const a = await create(admin, { name: 'Situação inválida' });
    for (const status of ['draft', 'archived', 'ativa']) {
      expect((await admin.patch(`/api/automations/${a.id}/status`, { status })).statusCode, status).toBe(400);
    }
    expect((await admin.patch(`/api/automations/${a.id}/status`, {})).statusCode).toBe(400);
  });

  it('id que não é número responde 404', async () => {
    for (const url of ['/api/automations/abc', '/api/automations/0', '/api/automations/-3']) {
      expect((await admin.get(url)).statusCode, url).toBe(404);
    }
    expect((await admin.patch('/api/automations/abc', { name: 'x' })).statusCode).toBe(404);
    expect((await admin.patch('/api/automations/abc/status', { status: 'active' })).statusCode).toBe(404);
    expect((await admin.post('/api/automations/abc/archive')).statusCode).toBe(404);
  });

  it('a permissão vem antes da validação: atendente com corpo inválido recebe 403, não 400', async () => {
    expect((await atendente.post('/api/automations', {})).statusCode).toBe(403);
  });
});
