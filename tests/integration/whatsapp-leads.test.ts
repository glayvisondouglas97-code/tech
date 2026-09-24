import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LeadDetail } from '../../src/shared/api';
import type { ConversationItem, LeadChatResult } from '../../src/shared/conversations';
import { type FakeEvolution, startFakeEvolution } from '../fake-evolution';
import {
  type Client,
  createTestApp,
  createUser,
  loginAs,
  seedList,
  type TestApp,
  testPhone,
} from '../helpers';

const TOKEN = 'token-do-webhook-de-teste';
let t: TestApp;
let fake: FakeEvolution;
let media: string;
let dono: Client;
let ana: Client;
let bruno: Client;
let ids: { ana: string; bruno: string };
/** Números da Ana: 1 conectado, 2 desconectado. Número 3: do Bruno. */
let n1: number;
let n2: number;
let n3: number;
/** Leads na fila da Ana. */
let lead1: number;
let lead2: number;
let lead3: number;
let noWhatsapp: number;
let oldAccount: number;

function hook(event: string, data: unknown, instance = 'whatsapp-01') {
  return t.app.inject({
    method: 'POST',
    url: '/webhook/evolution',
    payload: { event, instance, data },
    headers: { 'x-webhook-token': TOKEN },
  });
}
const detail = async (c: Client, id: number) => (await c.get(`/api/leads/${id}`)).json() as LeadDetail;
const open = (c: Client, leadId: number, instanceId = n1) =>
  c.post(`/api/leads/${leadId}/conversation`, { instanceId });

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
  const b = await createUser(t.db, { name: 'Bruno', role: 'atendente' });
  ids = { ana: a.id, bruno: b.id };
  ana = await loginAs(t.app, a);
  bruno = await loginAs(t.app, b);
  dono = await loginAs(t.app, await createUser(t.db, { name: 'Dono', role: 'dono' }));

  await hook('connection.update', { state: 'open', wuid: '5511900000000@s.whatsapp.net' });
  await hook('connection.update', { state: 'close' }, 'whatsapp-02');
  await hook('connection.update', { state: 'open' }, 'whatsapp-03');
  fake.closed.add('whatsapp-02');
  const instances = await t.db.selectFrom('wa_instances').select(['id', 'name']).orderBy('name').execute();
  [n1, n2, n3] = instances.map((i) => i.id) as [number, number, number];
  await t.db.updateTable('wa_instances').set({ owner_id: a.id }).where('id', 'in', [n1, n2]).execute();
  await t.db.updateTable('wa_instances').set({ owner_id: b.id }).where('id', '=', n3).execute();

  [lead1, lead2, lead3] = (await seedList(t.db, { count: 3, assignTo: a.id, phoneStart: 100 })).leadIds as [
    number,
    number,
    number,
  ];
  [noWhatsapp] = (await seedList(t.db, { count: 1, assignTo: a.id, phoneStart: 9999 })).leadIds as [number];
  [oldAccount] = (await seedList(t.db, { count: 1, assignTo: a.id, phoneStart: 8888 })).leadIds as [number];
  await t.db.updateTable('leads').set({ company: 'Padaria Pão Quente' }).where('id', '=', lead1).execute();
});

afterAll(async () => {
  await t?.close();
  await fake?.close();
  rmSync(media, { recursive: true, force: true });
});

describe('botão "Chamar" pelo sistema', () => {
  let conversationId: number;

  it('abre a conversa pelo número escolhido, ainda sem mensagens e fora da lista', async () => {
    const r = await open(ana, lead1);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as LeadChatResult;
    expect(body.warning).toBeNull();
    conversationId = body.conversationId;

    const check = fake.calls.find((c) => c.url === '/chat/whatsappNumbers/whatsapp-01');
    expect(check?.body).toEqual({ numbers: [testPhone(100)] });

    const conv = (await ana.get(`/api/conversations/${conversationId}`)).json() as ConversationItem;
    expect(conv).toMatchObject({
      lastMessageAt: null,
      instance: { id: n1 },
      contact: { phone: testPhone(100) },
      lead: { id: lead1, label: 'Padaria Pão Quente' },
    });
    const list = (await ana.get('/api/conversations?tab=todas')).json() as ConversationItem[];
    expect(list.some((c) => c.id === conversationId)).toBe(false);

    const d = await detail(ana, lead1);
    expect(d.lead.status).toBe('pendente');
    expect(d.lead.whatsappOpenedAt).not.toBeNull();
    expect(d.events[0]?.type).toBe('abriu_whatsapp');

    // Chamar de novo pelo mesmo número reaproveita a conversa.
    expect((await open(ana, lead1)).json().conversationId).toBe(conversationId);
    expect((await ana.get(`/api/leads/${lead1}/conversations`)).json()).toEqual([
      { id: conversationId, instanceId: n1 },
    ]);
  });

  it('a primeira mensagem enviada pelo sistema marca "Chamado · Mensagem enviada"', async () => {
    const sent = await ana.post(`/api/conversations/${conversationId}/messages`, { text: 'Oi, tudo bem?' });
    expect(sent.statusCode, sent.body).toBe(201);
    const d = await detail(ana, lead1);
    expect(d.lead).toMatchObject({ status: 'chamado', result: 'enviado', calledBy: { id: ids.ana } });
    expect(d.events[0]).toMatchObject({
      type: 'chamado',
      user: { name: 'Ana' },
      data: { resultado: 'enviado', automatico: true, numero: 'whatsapp-01' },
    });
    const stats = (await ana.get('/api/queue/stats')).json();
    expect(stats.chameiHoje).toBe(1);

    // Agora aparece na lista, e a busca acha pela empresa do lead.
    const found = (await ana.get('/api/conversations?tab=todas&q=padaria')).json() as ConversationItem[];
    expect(found.map((c) => c.id)).toEqual([conversationId]);
    expect(found[0]?.lastMessagePreview).toBe('Oi, tudo bem?');

    // A segunda mensagem não mexe no lead.
    await ana.post(`/api/conversations/${conversationId}/messages`, { text: 'Posso mandar um áudio?' });
    expect((await detail(ana, lead1)).lead.version).toBe(d.lead.version);
  });

  it('a resposta do lead passa o resultado para "Respondeu" sozinho', async () => {
    const reply = (id: string, text: string) =>
      hook('messages.upsert', {
        key: { id, remoteJid: `${testPhone(100)}@s.whatsapp.net`, fromMe: false },
        pushName: 'Seu Joaquim',
        status: 'DELIVERY_ACK',
        message: { conversation: text },
        messageType: 'conversation',
        messageTimestamp: Math.floor(Date.now() / 1000),
      });
    expect((await reply('R1', 'Pode sim!')).statusCode).toBe(200);
    const d = await detail(ana, lead1);
    expect(d.lead.result).toBe('respondeu');
    expect(d.events.slice(0, 2).map((e) => [e.type, e.data])).toEqual([
      ['resultado', { de: 'enviado', para: 'respondeu', automatico: true }],
      ['whatsapp_resposta', { texto: 'Pode sim!' }],
    ]);
    // Outras mensagens do lead não repetem o registro no histórico.
    await reply('R2', 'Estou esperando');
    expect((await detail(ana, lead1)).events.length).toBe(d.events.length);
  });

  it('número sem WhatsApp: avisa (para marcar "Sem WhatsApp") e não cria conversa', async () => {
    const before = await t.db.selectFrom('wa_conversations').select('id').execute();
    const r = await open(ana, noWhatsapp);
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({
      code: 'sem_whatsapp',
      error: 'O número (41) 98000-9999 não tem WhatsApp.',
    });
    expect(await t.db.selectFrom('wa_conversations').select('id').execute()).toHaveLength(before.length);
  });

  it('conta antiga, sem o 9º dígito: usa o número que o WhatsApp devolveu', async () => {
    const r = await open(ana, oldAccount);
    expect(r.statusCode, r.body).toBe(200);
    const id = r.json().conversationId;
    const conv = (await ana.get(`/api/conversations/${id}`)).json() as ConversationItem;
    expect(conv.contact.phone).toBe('554180008888');
    await ana.post(`/api/conversations/${id}/messages`, { text: 'Olá!' });
    const call = fake.calls.filter((c) => c.url === '/message/sendText/whatsapp-01').at(-1);
    expect(call?.body).toEqual({ number: '554180008888@s.whatsapp.net', text: 'Olá!' });
  });

  it('número desconectado: aviso e nada criado', async () => {
    const r = await open(ana, lead2, n2);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/whatsapp-02 está desconectado/);
    expect((await ana.get(`/api/leads/${lead2}/conversations`)).json()).toEqual([]);
  });

  it('atendente não chama nem vê as conversas de um lead de outra pessoa', async () => {
    expect((await open(bruno, lead2, n3)).statusCode).toBe(404);
    expect((await bruno.get(`/api/leads/${lead2}/conversations`)).statusCode).toBe(404);
  });

  it('atendente só chama pelos números dele', async () => {
    const [brunoLead] = (await seedList(t.db, { count: 1, assignTo: ids.bruno, phoneStart: 400 }))
      .leadIds as [number];
    const r = await open(bruno, brunoLead, n1);
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('Número não encontrado.');
    // O dono chama por qualquer número.
    expect((await open(dono, brunoLead, n3)).statusCode).toBe(200);
  });

  it('mensagem de outra pessoa na conversa não tira o lead da fila de quem pegou', async () => {
    const id = (await open(ana, lead2)).json().conversationId;
    await dono.post(`/api/conversations/${id}/messages`, { text: 'Oi, aqui é o gestor' });
    expect((await detail(ana, lead2)).lead).toMatchObject({
      status: 'pendente',
      assignedTo: { id: ids.ana },
    });
    await ana.post(`/api/conversations/${id}/messages`, { text: 'Oi, aqui é a Ana' });
    expect((await detail(ana, lead2)).lead).toMatchObject({ status: 'chamado', calledBy: { id: ids.ana } });
  });

  it('lead na lista de não contatar não pode ser chamado', async () => {
    expect((await ana.post(`/api/leads/${lead3}/optout`, {})).statusCode).toBe(200);
    const r = await open(dono, lead3);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/não contatar/);
  });

  it('avisa quando o atendente abre conversas rápido demais', async () => {
    await t.db.updateTable('settings').set({ hourly_contact_warning: 3 }).execute();
    const { leadIds } = await seedList(t.db, { count: 3, assignTo: ids.bruno, phoneStart: 300 });
    const results = [];
    for (const id of leadIds) results.push((await open(bruno, id, n3)).json() as LeadChatResult);
    expect(results[0]?.warning).toBeNull();
    expect(results[2]?.warning).toMatch(/3 conversas na última hora/);
  });

  it('as mensagens prontas saíram', async () => {
    expect((await dono.get('/api/templates')).statusCode).toBe(404);
    expect((await dono.get('/api/app-config')).json()).not.toHaveProperty('templates');
  });
});
