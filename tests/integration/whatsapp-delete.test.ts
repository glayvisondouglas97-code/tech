import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatMessage, ConversationItem, InstanceInfo } from '../../src/shared/conversations';
import { type FakeEvolution, startFakeEvolution } from '../fake-evolution';
import { type Client, createTestApp, createUser, loginAs, type TestApp } from '../helpers';

/** Apagar mensagens (para mim e para todos), excluir conversas e excluir números. */

const TOKEN = 'token-do-webhook-de-teste';
const P1 = '5511911112222';
const P2 = '5511933334444';
let t: TestApp;
let fake: FakeEvolution;
let media: string;
let dono: Client;
let sup: Client;
let ana: Client;
let bruno: Client;
let n1: number;
let n2: number;
let conv1: number;

function hook(event: string, data: unknown, instance = 'whatsapp-01') {
  return t.app.inject({
    method: 'POST',
    url: '/webhook/evolution',
    payload: { event, instance, data },
    headers: { 'x-webhook-token': TOKEN },
  });
}
function message(id: string, phone: string, text: string, fromMe = false, secondsAgo = 0) {
  return hook(fromMe ? 'send.message' : 'messages.upsert', {
    key: { id, remoteJid: `${phone}@s.whatsapp.net`, fromMe },
    pushName: fromMe ? '' : 'Lead',
    status: fromMe ? 'SERVER_ACK' : 'DELIVERY_ACK',
    message: { conversation: text },
    messageType: 'conversation',
    messageTimestamp: Math.floor(Date.now() / 1000) - secondsAgo,
  });
}
const messages = async (c: Client, id: number) =>
  (await c.get(`/api/conversations/${id}/messages`)).json() as ChatMessage[];
const idOf = async (waId: string) =>
  (await t.db.selectFrom('wa_messages').select('id').where('wa_id', '=', waId).executeTakeFirstOrThrow()).id;
const list = async (c: Client) => (await c.get('/api/conversations?tab=todas')).json() as ConversationItem[];

beforeAll(async () => {
  fake = await startFakeEvolution();
  media = mkdtempSync(join(tmpdir(), 'midias-'));
  t = await createTestApp({
    env: {
      EVOLUTION_URL: fake.url,
      EVOLUTION_API_KEY: 'chave-teste',
      WEBHOOK_TOKEN: TOKEN,
      MEDIA_DIR: media,
    },
  });
  const a = await createUser(t.db, { name: 'Ana', role: 'atendente' });
  ana = await loginAs(t.app, a);
  bruno = await loginAs(t.app, await createUser(t.db, { name: 'Bruno', role: 'atendente' }));
  sup = await loginAs(t.app, await createUser(t.db, { name: 'Sílvia', role: 'supervisor' }));
  dono = await loginAs(t.app, await createUser(t.db, { name: 'Dono', role: 'dono' }));
  await hook('connection.update', { state: 'open', wuid: '5511900000001@s.whatsapp.net' });
  await hook('connection.update', { state: 'open', wuid: '5511900000002@s.whatsapp.net' }, 'whatsapp-02');
  const rows = await t.db.selectFrom('wa_instances').select(['id', 'name']).orderBy('name').execute();
  [n1, n2] = rows.map((r) => r.id) as [number, number];
  await t.db.updateTable('wa_instances').set({ owner_id: a.id }).where('id', '=', n1).execute();

  await message('OLD1', P1, 'Mensagem de 3 dias atrás', true, 3 * 86400);
  await message('I1', P1, 'Oi, primeira');
  await message('I2', P1, 'Oi, segunda');
  conv1 = (await list(ana))[0]?.id as number;
});

afterAll(async () => {
  await t?.close();
  await fake?.close();
  rmSync(media, { recursive: true, force: true });
});

describe('apagar mensagens', () => {
  it('para mim: some do sistema e não volta nem com o aviso repetido', async () => {
    const r = await ana.post(`/api/conversations/${conv1}/messages/delete`, { ids: [await idOf('I1')] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ deleted: 1, failed: 0 });
    expect((await messages(ana, conv1)).map((m) => m.waId)).toEqual(['OLD1', 'I2']);
    await message('I1', P1, 'Oi, primeira');
    expect((await messages(ana, conv1)).map((m) => m.waId)).toEqual(['OLD1', 'I2']);
    expect(fake.calls.some((c) => c.url.startsWith('/chat/deleteMessageForEveryone'))).toBe(false);
  });

  it('para todos: só mensagens enviadas pelo número nas últimas 48 horas', async () => {
    const sent = await ana.post(`/api/conversations/${conv1}/messages`, { text: 'Vou apagar esta' });
    const sentId = sent.json().id as number;
    const sentWa = sent.json().waId as string;
    for (const id of [await idOf('I2'), await idOf('OLD1')]) {
      const r = await ana.post(`/api/conversations/${conv1}/messages/delete`, {
        ids: [id],
        forEveryone: true,
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/últimas 48 horas/);
    }
    const r = await ana.post(`/api/conversations/${conv1}/messages/delete`, {
      ids: [sentId],
      forEveryone: true,
    });
    expect(r.statusCode, r.body).toBe(200);
    const call = fake.calls.find((c) => c.url === '/chat/deleteMessageForEveryone/whatsapp-01');
    expect(call).toMatchObject({
      method: 'DELETE',
      body: { id: sentWa, remoteJid: `${P1}@s.whatsapp.net`, fromMe: true },
    });
    expect((await messages(ana, conv1)).some((m) => m.id === sentId)).toBe(false);
  });

  it('a lista mostra a última mensagem que sobrou', async () => {
    await ana.post(`/api/conversations/${conv1}/messages/delete`, { ids: [await idOf('I2')] });
    const conv = (await list(ana)).find((c) => c.id === conv1);
    expect(conv).toMatchObject({
      lastMessagePreview: 'Mensagem de 3 dias atrás',
      lastMessageFromMe: true,
      unreadCount: 0,
    });
  });

  it('quem não cuida do número não apaga', async () => {
    const id = await idOf('OLD1');
    expect((await bruno.post(`/api/conversations/${conv1}/messages/delete`, { ids: [id] })).statusCode).toBe(
      404,
    );
    expect((await sup.post(`/api/conversations/${conv1}/messages/delete`, { ids: [id] })).statusCode).toBe(
      403,
    );
    expect(
      (await ana.post(`/api/conversations/${conv1}/messages/delete`, { ids: [999999] })).statusCode,
    ).toBe(404);
  });
});

describe('excluir conversas', () => {
  it('apaga as conversas escolhidas; se o contato escrever de novo, volta só com o novo', async () => {
    await message('J1', P2, 'Outra conversa');
    const ids = (await list(ana)).map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect((await bruno.post('/api/conversations/delete', { ids })).statusCode).toBe(404);
    expect((await sup.post('/api/conversations/delete', { ids })).statusCode).toBe(403);

    const r = await ana.post('/api/conversations/delete', { ids });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ deleted: 2, messages: 2 });
    expect(await list(ana)).toEqual([]);
    expect(await t.db.selectFrom('wa_contacts').select('id').execute()).toEqual([]);

    await message('J1', P2, 'Outra conversa'); // aviso repetido: não volta
    expect(await list(ana)).toEqual([]);
    await message('J2', P2, 'Voltei!');
    const again = await list(ana);
    expect(again).toHaveLength(1);
    expect((await messages(ana, again[0]?.id as number)).map((m) => m.text)).toEqual(['Voltei!']);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('details')
      .where('action', '=', 'excluiu_conversas')
      .executeTakeFirstOrThrow();
    expect(audit.details).toEqual({ quantidade: 2, mensagens: 2 });
  });
});

describe('excluir número', () => {
  it('pede EXCLUIR; tira da Evolution e do sistema; aviso atrasado não traz de volta', async () => {
    await message('K1', P1, 'No número 2', false, 0).then(() => message('K2', P1, 'mais uma', false));
    await hook(
      'messages.upsert',
      {
        key: { id: 'K3', remoteJid: `${P2}@s.whatsapp.net`, fromMe: false },
        message: { conversation: 'no número 2' },
        messageType: 'conversation',
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
      'whatsapp-02',
    );
    expect((await dono.post(`/api/instances/${n2}/delete`, { confirm: 'sim' })).statusCode).toBe(400);
    expect((await ana.post(`/api/instances/${n2}/delete`, { confirm: 'EXCLUIR' })).statusCode).toBe(404);
    expect((await sup.post(`/api/instances/${n1}/delete`, { confirm: 'EXCLUIR' })).statusCode).toBe(403);

    const r = await dono.post(`/api/instances/${n2}/delete`, { confirm: 'excluir' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ conversations: 1, messages: 1 });
    expect(fake.calls.some((c) => c.method === 'DELETE' && c.url === '/instance/delete/whatsapp-02')).toBe(
      true,
    );
    const names = ((await dono.get('/api/instances')).json() as InstanceInfo[]).map((i) => i.name);
    expect(names).toEqual(['whatsapp-01']);

    await hook('connection.update', { state: 'close' }, 'whatsapp-02');
    await hook(
      'messages.upsert',
      {
        key: { id: 'K4', remoteJid: `${P2}@s.whatsapp.net`, fromMe: false },
        message: { conversation: 'atrasada' },
        messageType: 'conversation',
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
      'whatsapp-02',
    );
    expect(((await dono.get('/api/instances')).json() as InstanceInfo[]).map((i) => i.name)).toEqual([
      'whatsapp-01',
    ]);
    // O próximo número novo não reaproveita o nome do que acabou de sair.
    const created = await dono.post('/api/instances', { nickname: 'Novo' });
    expect(created.json().name).toBe('whatsapp-03');
  });

  it('se a Evolution recusar, nada muda e o número continua recebendo avisos', async () => {
    fake.undeletable.add('whatsapp-01');
    const r = await ana.post(`/api/instances/${n1}/delete`, { confirm: 'EXCLUIR' });
    expect(r.statusCode).toBe(502);
    fake.undeletable.delete('whatsapp-01');
    expect(((await ana.get('/api/instances')).json() as InstanceInfo[]).map((i) => i.name)).toEqual([
      'whatsapp-01',
    ]);
    await message('K9', P1, 'ainda chega');
    expect((await list(ana)).some((c) => c.lastMessagePreview === 'ainda chega')).toBe(true);
  });

  it('o responsável exclui o próprio número, mesmo que a Evolution já não o tenha', async () => {
    fake.missing.add('whatsapp-01');
    const r = await ana.post(`/api/instances/${n1}/delete`, { confirm: 'EXCLUIR' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await ana.get('/api/instances')).json()).toEqual([]);
    expect(await list(ana)).toEqual([]);
    const audit = await t.db
      .selectFrom('audit_log')
      .select(['details', 'entity_id'])
      .where('action', '=', 'excluiu_numero')
      .orderBy('id')
      .execute();
    expect(audit.map((a) => a.entity_id)).toEqual(['whatsapp-02', 'whatsapp-01']);
  });
});
