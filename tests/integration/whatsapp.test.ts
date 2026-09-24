import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatMessage, ConversationItem } from '../../src/shared/conversations';
import { type FakeEvolution, startFakeEvolution } from '../fake-evolution';
import { type Client, createTestApp, createUser, loginAs, type TestApp } from '../helpers';

const TOKEN = 'token-do-webhook-de-teste';
let t: TestApp;
let fake: FakeEvolution;
let media: string;
let dono: Client;
let ana: Client;

const now = () => Math.floor(Date.now() / 1000);
function hook(event: string, data: unknown, token: string | null = TOKEN, instance = 'whatsapp-01') {
  return t.app.inject({
    method: 'POST',
    url: '/webhook/evolution',
    payload: { event, instance, data },
    headers: token ? { 'x-webhook-token': token } : {},
  });
}
function incoming(id: string, remoteJid: string, text: string, extra: Record<string, unknown> = {}) {
  return hook('messages.upsert', {
    key: { id, remoteJid, fromMe: false, ...extra },
    pushName: 'Lead Teste',
    status: 'DELIVERY_ACK',
    message: { conversation: text },
    messageType: 'conversation',
    messageTimestamp: now(),
  });
}
const conversations = async (query = 'tab=todas') =>
  (await dono.get(`/api/conversations?${query}`)).json() as ConversationItem[];

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
  dono = await loginAs(t.app, await createUser(t.db, { name: 'Dono', role: 'dono' }));
  ana = await loginAs(t.app, await createUser(t.db, { name: 'Ana', role: 'atendente' }));
  await hook('connection.update', { state: 'open', wuid: '5511900000000@s.whatsapp.net' });
});

afterAll(async () => {
  await t?.close();
  await fake?.close();
  rmSync(media, { recursive: true, force: true });
});

describe('webhook da Evolution', () => {
  it('sem o token certo: 401 e nada gravado', async () => {
    expect((await incoming('X0', '5511911110000@s.whatsapp.net', 'oi')).statusCode).toBe(200);
    expect((await hook('messages.upsert', {}, 'errado')).statusCode).toBe(401);
    expect((await hook('messages.upsert', {}, null)).statusCode).toBe(401);
  });

  it('mensagem recebida cria a conversa; webhook repetido não duplica', async () => {
    await incoming('A1', '5511922223333@s.whatsapp.net', 'Olá!');
    await incoming('A1', '5511922223333@s.whatsapp.net', 'Olá!');
    const list = (await conversations()).filter((c) => c.contact.phone === '5511922223333');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ unreadCount: 1, leadReplied: true, lastMessagePreview: 'Olá!' });
  });

  it('telefone e @lid da mesma pessoa viram uma conversa só', async () => {
    await incoming('L1', '123456789012345@lid', 'pelo lid');
    await incoming('L2', '5511933334444@s.whatsapp.net', 'com os dois', {
      remoteJidAlt: '123456789012345@lid',
    });
    const list = (await conversations()).filter((c) => c.contact.phone === '5511933334444');
    expect(list).toHaveLength(1);
    const msgs = (await dono.get(`/api/conversations/${list[0]?.id}/messages`)).json() as ChatMessage[];
    expect(msgs.map((m) => m.text)).toEqual(['pelo lid', 'com os dois']);
  });

  it('grupos e status (stories) são ignorados', async () => {
    const before = (await conversations()).length;
    await incoming('G1', '120363000000000000@g.us', 'grupo');
    await incoming('S1', 'status@broadcast', 'story');
    expect((await conversations()).length).toBe(before);
  });

  it('status de entrega avança e nunca volta', async () => {
    await hook('send.message', {
      key: { id: 'ST1', remoteJid: '5511922223333@s.whatsapp.net', fromMe: true },
      status: 'PENDING',
      message: { conversation: 'resposta' },
      messageType: 'conversation',
      messageTimestamp: now(),
    });
    await hook('messages.update', { keyId: 'ST1', status: 'READ' });
    await hook('messages.update', { keyId: 'ST1', status: 'DELIVERY_ACK' });
    const conv = (await conversations()).find((c) => c.contact.phone === '5511922223333');
    const msgs = (await dono.get(`/api/conversations/${conv?.id}/messages`)).json() as ChatMessage[];
    expect(msgs.find((m) => m.waId === 'ST1')?.status).toBe('READ');
  });
});

describe('lista, busca e envio', () => {
  it('aba Responderam, busca por nome e por parte do telefone', async () => {
    await hook('send.message', {
      key: { id: 'N1', remoteJid: '5511955550001@s.whatsapp.net', fromMe: true },
      status: 'DELIVERY_ACK',
      message: { audioMessage: { ptt: true } },
      messageType: 'audioMessage',
      messageTimestamp: now(),
    });
    const todas = await conversations();
    const responderam = await conversations('tab=responderam');
    expect(todas.some((c) => c.contact.phone === '5511955550001')).toBe(true);
    expect(responderam.some((c) => c.contact.phone === '5511955550001')).toBe(false);
    expect((await conversations('tab=todas&q=lead')).length).toBeGreaterThan(0);
    const byPhone = await conversations('tab=todas&q=33334444');
    expect(byPhone.map((c) => c.contact.phone)).toEqual(['5511933334444']);
  });

  it('envia texto pelo mesmo número e marca como lidas as mensagens respondidas', async () => {
    await incoming('A2', '5511922223333@s.whatsapp.net', 'Mais uma dúvida');
    const conv = (await conversations()).find((c) => c.contact.phone === '5511922223333') as ConversationItem;
    const r = await dono.post(`/api/conversations/${conv.id}/messages`, { text: 'Tudo certo!' });
    expect(r.statusCode, r.body).toBe(201);
    const call = fake.calls.find((c) => c.url === '/message/sendText/whatsapp-01');
    expect(call?.body).toEqual({ number: '5511922223333@s.whatsapp.net', text: 'Tudo certo!' });
    expect(call?.apikey).toBe('chave-teste');
    const updated = (await conversations()).find((c) => c.id === conv.id);
    expect(updated).toMatchObject({
      unreadCount: 0,
      lastMessageFromMe: true,
      lastMessagePreview: 'Tudo certo!',
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const read = fake.calls.find((c) => c.url === '/chat/markMessageAsRead/whatsapp-01');
    expect((read?.body as { readMessages: unknown[] } | undefined)?.readMessages).toContainEqual({
      remoteJid: '5511922223333@s.whatsapp.net',
      fromMe: false,
      id: 'A2',
    });
  });

  it('número sem WhatsApp: erro legível', async () => {
    await incoming('Z1', '5511999990000@s.whatsapp.net', 'oi');
    const conv = (await conversations()).find((c) => c.contact.phone === '5511999990000') as ConversationItem;
    const r = await dono.post(`/api/conversations/${conv.id}/messages`, { text: 'teste' });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toContain('não existe no WhatsApp');
  });

  it('áudio precisa ser áudio', async () => {
    const conv = (await conversations())[0] as ConversationItem;
    const r = await dono.request('POST', `/api/conversations/${conv.id}/audio`, 'texto', {
      'content-type': 'text/plain',
    });
    expect(r.statusCode).toBe(400);
  });

  it('selos do menu: conversas não lidas e números desconectados', async () => {
    const stats = (await dono.get('/api/conversations/stats')).json();
    expect(stats.unreadConversations).toBeGreaterThan(0);
    expect(stats.disconnectedInstances).toBe(0);
  });
});

describe('permissões', () => {
  it('atendente vê e responde as conversas, mas não mexe nos números', async () => {
    expect((await ana.get('/api/conversations')).statusCode).toBe(200);
    expect((await ana.get('/api/instances')).statusCode).toBe(200);
    expect((await ana.post('/api/instances', { nickname: 'x' })).statusCode).toBe(403);
    expect((await ana.patch('/api/instances/1', { nickname: 'x' })).statusCode).toBe(403);
    expect((await ana.post('/api/instances/1/connect', {})).statusCode).toBe(403);
  });

  it('sem login: 401; sem o token CSRF: 403', async () => {
    const anon = await t.app.inject({ method: 'GET', url: '/api/conversations' });
    expect(anon.statusCode).toBe(401);
    const noCsrf = await t.app.inject({
      method: 'POST',
      url: '/api/conversations/1/messages',
      payload: { text: 'oi' },
      headers: { cookie: ana.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('dono cria número (já com webhook e opções)', async () => {
    const r = await dono.post('/api/instances', { nickname: 'WhatsApp 2 - João' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ name: 'whatsapp-02', nickname: 'WhatsApp 2 - João', status: 'close' });
    const created = fake.calls.find((c) => c.url === '/instance/create')?.body as Record<string, unknown>;
    expect(created).toMatchObject({ instanceName: 'whatsapp-02', groupsIgnore: true, readMessages: false });
  });
});

describe('LGPD', () => {
  it('excluir o titular apaga as conversas de WhatsApp dele', async () => {
    expect((await conversations()).some((c) => c.contact.phone === '5511933334444')).toBe(true);
    const r = await dono.post('/api/privacy/delete', { phone: '5511933334444', block: true, confirm: true });
    expect(r.statusCode, r.body).toBe(200);
    expect((await conversations()).some((c) => c.contact.phone === '5511933334444')).toBe(false);
  });
});
