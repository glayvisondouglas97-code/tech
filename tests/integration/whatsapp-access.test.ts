import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationItem, InstanceInfo } from '../../src/shared/conversations';
import { type FakeEvolution, startFakeEvolution } from '../fake-evolution';
import { type Client, createTestApp, createUser, loginAs, type TestApp } from '../helpers';

/**
 * Números por responsável: o atendente vê só as conversas dos números dele (pela API e pelo tempo real);
 * dono, administrador e supervisor veem todas; dono e administrador trocam o responsável.
 */

const TOKEN = 'token-do-webhook-de-teste';
let t: TestApp;
let fake: FakeEvolution;
let media: string;
let baseUrl: string;
let dono: Client;
let admin: Client;
let sup: Client;
let ana: Client;
let bruno: Client;
let ids: { ana: string; bruno: string; sup: string };
/** whatsapp-01: sem responsável (número antigo). whatsapp-02: cadastrado pela Ana. */
let n1: number;
let n2: number;
let convN1: number;
let convN2: number;
const sockets: Socket[] = [];

function hook(event: string, data: unknown, instance: string) {
  return t.app.inject({
    method: 'POST',
    url: '/webhook/evolution',
    payload: { event, instance, data },
    headers: { 'x-webhook-token': TOKEN },
  });
}
let seq = 0;
function incoming(instance: string, phone: string, text = 'Olá!') {
  return hook(
    'messages.upsert',
    {
      key: { id: `IN-${++seq}`, remoteJid: `${phone}@s.whatsapp.net`, fromMe: false },
      pushName: 'Lead',
      status: 'DELIVERY_ACK',
      message: { conversation: text },
      messageType: 'conversation',
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
    instance,
  );
}
const list = async (c: Client) => (await c.get('/api/conversations?tab=todas')).json() as ConversationItem[];
const numbers = async (c: Client) =>
  ((await c.get('/api/instances')).json() as InstanceInfo[]).map((i) => i.name);

/** Tempo real de uma pessoa: guarda todos os avisos que chegam. */
async function live(c: Client) {
  const socket = connect(baseUrl, {
    transports: ['websocket'],
    extraHeaders: { cookie: c.cookie },
    reconnection: false,
  });
  sockets.push(socket);
  const events: { event: string; data: unknown }[] = [];
  socket.onAny((event: string, data: unknown) => events.push({ event, data }));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return {
    events,
    got: (event: string, match: (data: never) => boolean = () => true) =>
      events.some((e) => e.event === event && match(e.data as never)),
    clear: () => events.splice(0),
  };
}
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('aviso não chegou');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const pause = (ms = 300) => new Promise((r) => setTimeout(r, ms));

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
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const address = t.app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const a = await createUser(t.db, { name: 'Ana', role: 'atendente' });
  const b = await createUser(t.db, { name: 'Bruno', role: 'atendente' });
  const s = await createUser(t.db, { name: 'Sílvia', role: 'supervisor' });
  ids = { ana: a.id, bruno: b.id, sup: s.id };
  ana = await loginAs(t.app, a);
  bruno = await loginAs(t.app, b);
  sup = await loginAs(t.app, s);
  admin = await loginAs(t.app, await createUser(t.db, { name: 'Admin', role: 'admin' }));
  dono = await loginAs(t.app, await createUser(t.db, { name: 'Dono', role: 'dono' }));

  await hook('connection.update', { state: 'open', wuid: '5511900000001@s.whatsapp.net' }, 'whatsapp-01');
  n1 = (await t.db.selectFrom('wa_instances').select('id').executeTakeFirstOrThrow()).id;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await t?.close();
  await fake?.close();
  rmSync(media, { recursive: true, force: true });
});

describe('números por responsável', () => {
  it('atendente cadastra o próprio número e fica como responsável', async () => {
    const r = await ana.post('/api/instances', { nickname: 'WhatsApp da Ana' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ name: 'whatsapp-02', owner: { id: ids.ana, name: 'Ana' } });
    n2 = r.json().id;
    await hook('connection.update', { state: 'open', wuid: '5511900000002@s.whatsapp.net' }, 'whatsapp-02');

    expect(await numbers(ana)).toEqual(['whatsapp-02']);
    expect(await numbers(bruno)).toEqual([]);
    expect(await numbers(sup)).toEqual(['whatsapp-01', 'whatsapp-02']);
    expect(await numbers(dono)).toEqual(['whatsapp-01', 'whatsapp-02']);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('user_id')
      .where('action', '=', 'criou_numero')
      .executeTakeFirst();
    expect(audit?.user_id).toBe(ids.ana);
  });

  it('cada atendente vê só as conversas dos números dele; a gestão vê todas', async () => {
    await incoming('whatsapp-01', '5511911110001');
    await incoming('whatsapp-02', '5511911110002');
    const all = await list(sup);
    convN1 = all.find((c) => c.instance.id === n1)?.id as number;
    convN2 = all.find((c) => c.instance.id === n2)?.id as number;
    expect(all).toHaveLength(2);
    expect((await list(admin)).map((c) => c.id).sort()).toEqual([convN1, convN2].sort());
    expect((await list(ana)).map((c) => c.id)).toEqual([convN2]);
    expect(await list(bruno)).toEqual([]);
    expect((await ana.get('/api/conversations/stats')).json()).toEqual({
      unreadConversations: 1,
      disconnectedInstances: 0,
    });
    expect((await sup.get('/api/conversations/stats')).json().unreadConversations).toBe(2);
  });

  it('conversa de um número que não é seu: 404 em tudo', async () => {
    const message = await t.db
      .selectFrom('wa_messages')
      .select('id')
      .where('conversation_id', '=', convN1)
      .executeTakeFirstOrThrow();
    expect((await ana.get(`/api/conversations/${convN1}`)).statusCode).toBe(404);
    expect((await ana.get(`/api/conversations/${convN1}/messages`)).statusCode).toBe(404);
    expect((await ana.post(`/api/conversations/${convN1}/read`, {})).statusCode).toBe(404);
    expect((await ana.post(`/api/conversations/${convN1}/messages`, { text: 'oi' })).statusCode).toBe(404);
    expect((await ana.get(`/api/messages/${message.id}/media`)).statusCode).toBe(404);
    expect(fake.calls.some((c) => c.url.startsWith('/message/sendText/whatsapp-01'))).toBe(false);
    // Na conversa do próprio número, responde normalmente.
    expect((await ana.post(`/api/conversations/${convN2}/messages`, { text: 'Oi!' })).statusCode).toBe(201);
  });

  it('o responsável conecta e renomeia; o supervisor vê, mas não mexe; o administrador mexe em todos', async () => {
    expect((await ana.patch(`/api/instances/${n2}`, { nickname: 'Ana - vendas' })).json().nickname).toBe(
      'Ana - vendas',
    );
    expect((await ana.post(`/api/instances/${n2}/connect`, {})).statusCode).toBe(200);
    expect((await sup.post(`/api/instances/${n2}/connect`, {})).statusCode).toBe(403);
    expect((await sup.patch(`/api/instances/${n2}`, { nickname: 'x' })).statusCode).toBe(403);
    expect((await admin.post(`/api/instances/${n1}/connect`, {})).statusCode).toBe(200);
    expect((await admin.patch(`/api/instances/${n1}`, { nickname: 'Comercial' })).statusCode).toBe(200);
  });

  it('só o dono e o administrador trocam o responsável', async () => {
    expect((await ana.patch(`/api/instances/${n2}`, { ownerId: ids.bruno })).statusCode).toBe(403);
    expect((await sup.patch(`/api/instances/${n1}`, { ownerId: ids.sup })).statusCode).toBe(403);
    const unknown = await admin.patch(`/api/instances/${n1}`, {
      ownerId: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.statusCode).toBe(400);

    const r = await admin.patch(`/api/instances/${n1}`, { ownerId: ids.bruno });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().owner).toEqual({ id: ids.bruno, name: 'Bruno' });
    expect((await list(bruno)).map((c) => c.id)).toEqual([convN1]);
    expect((await list(ana)).map((c) => c.id)).toEqual([convN2]);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('details')
      .where('action', '=', 'trocou_responsavel_numero')
      .executeTakeFirstOrThrow();
    expect(audit.details).toEqual({ de: 'sem responsável', para: 'Bruno' });
  });
});

describe('tempo real por responsável', () => {
  it('cada um recebe só os avisos dos números que vê; o QR Code vai só para quem pode conectar', async () => {
    const [a, b, s, ad] = await Promise.all([live(ana), live(bruno), live(sup), live(admin)]);

    await incoming('whatsapp-02', '5511911110002', 'Para a Ana');
    await until(() => a.got('message:new') && s.got('message:new'));
    await pause();
    expect(b.got('message:new')).toBe(false);

    for (const x of [a, b, s, ad]) x.clear();
    await incoming('whatsapp-01', '5511911110001', 'Para o Bruno');
    await until(() => b.got('message:new') && s.got('message:new'));
    await pause();
    expect(a.got('message:new')).toBe(false);
    expect(a.got('conversation:updated')).toBe(false);

    for (const x of [a, b, s, ad]) x.clear();
    await hook('qrcode.updated', { qrcode: { base64: 'data:image/png;base64,QR' } }, 'whatsapp-02');
    await until(() => a.got('instance:qrcode') && ad.got('instance:qrcode'));
    await pause();
    expect(s.got('instance:qrcode')).toBe(false);
    expect(b.got('instance:qrcode')).toBe(false);
  });

  it('trocar o responsável avisa o antigo (o número some) e o novo (o número aparece)', async () => {
    const [a, b] = await Promise.all([live(ana), live(bruno)]);
    expect((await admin.patch(`/api/instances/${n2}`, { ownerId: ids.bruno })).statusCode).toBe(200);
    await until(
      () =>
        a.got('instance:removed', (d: { id: number }) => d.id === n2) &&
        a.got('conversations:reload') &&
        b.got('instance:updated', (d: InstanceInfo) => d.id === n2) &&
        b.got('conversations:reload'),
    );
    expect(await list(ana)).toEqual([]);
    expect((await list(bruno)).map((c) => c.id).sort()).toEqual([convN1, convN2].sort());
  });

  it('papel alterado muda na hora o que o tempo real entrega', async () => {
    const s = await live(sup);
    const r = await dono.patch(`/api/users/${ids.sup}`, { role: 'atendente' });
    expect(r.statusCode, r.body).toBe(200);
    await until(() => s.got('conversations:reload'));
    s.clear();
    await incoming('whatsapp-01', '5511911110001', 'Depois da mudança');
    await pause(500);
    expect(s.got('message:new')).toBe(false);
    expect(await list(sup)).toEqual([]);
  });
});
