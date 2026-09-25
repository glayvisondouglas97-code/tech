import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LeadDetail } from '../../src/shared/api';
import type { AudioItem, ChatMessage, LeadChatResult } from '../../src/shared/conversations';
import { type FakeEvolution, startFakeEvolution } from '../fake-evolution';
import { type Client, createTestApp, createUser, loginAs, seedList, type TestApp } from '../helpers';

/** Biblioteca de áudios do Chamar (Plano A): o gestor salva versões; o botão Chamar sorteia e envia. */

const TOKEN = 'token-do-webhook-de-teste';
let t: TestApp;
let fake: FakeEvolution;
let media: string;
let admin: Client;
let ana: Client;
let n1: number;
let leads: number[];

function hook(event: string, data: unknown, instance = 'whatsapp-01') {
  return t.app.inject({
    method: 'POST',
    url: '/webhook/evolution',
    payload: { event, instance, data },
    headers: { 'x-webhook-token': TOKEN },
  });
}
/** Sobe um áudio para a biblioteca como um navegador faria (corpo = arquivo, rótulo no query). */
function uploadAudio(
  c: Client,
  label: string,
  seconds: number,
  mime = 'audio/ogg',
): Promise<LightMyRequestResponse> {
  const url = `/api/audios?label=${encodeURIComponent(label)}&seconds=${seconds}`;
  return c.request('POST', url, Buffer.from(`audio-${label}`), { 'content-type': mime });
}
const listAudios = async (c: Client) => (await c.get('/api/audios')).json() as AudioItem[];
const call = (c: Client, leadId: number, sendAudio = true) =>
  c.post(`/api/leads/${leadId}/conversation`, { instanceId: n1, sendAudio });
const messagesOf = async (id: number) =>
  (await admin.get(`/api/conversations/${id}/messages`)).json() as ChatMessage[];

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
  admin = await loginAs(t.app, await createUser(t.db, { name: 'Gestora', role: 'admin' }));

  await hook('connection.update', { state: 'open', wuid: '5511900000000@s.whatsapp.net' });
  const inst = await t.db.selectFrom('wa_instances').select('id').executeTakeFirstOrThrow();
  n1 = inst.id;
  await t.db.updateTable('wa_instances').set({ owner_id: a.id }).where('id', '=', n1).execute();
  leads = (await seedList(t.db, { count: 5, assignTo: a.id, phoneStart: 100 })).leadIds;
});

afterAll(async () => {
  await t?.close();
  await fake?.close();
  rmSync(media, { recursive: true, force: true });
});

describe('biblioteca de áudios', () => {
  it('só o gestor cadastra e vê os áudios', async () => {
    expect((await ana.get('/api/audios')).statusCode).toBe(403);
    expect((await uploadAudio(ana, 'Da Ana', 10)).statusCode).toBe(403);

    const a = await uploadAudio(admin, 'Apresentação A', 18);
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json()).toMatchObject({ label: 'Apresentação A', seconds: 18, mime: 'audio/ogg', active: true });
    expect((await uploadAudio(admin, 'Apresentação B', 25)).statusCode).toBe(201);
    expect((await listAudios(admin)).map((x) => x.label)).toEqual(['Apresentação B', 'Apresentação A']);
  });

  it('recusa sem nome e arquivo que não é áudio', async () => {
    expect((await uploadAudio(admin, '   ', 5)).statusCode).toBe(400);
    expect((await uploadAudio(admin, 'Texto', 5, 'text/plain')).statusCode).toBe(400);
  });

  it('liga/desliga e deixa ouvir', async () => {
    const [b] = await listAudios(admin);
    const off = await admin.patch(`/api/audios/${b?.id}`, { active: false });
    expect(off.json()).toMatchObject({ id: b?.id, active: false });
    const play = await admin.get(`/api/audios/${b?.id}/media`);
    expect(play.statusCode).toBe(200);
    expect(play.headers['content-type']).toContain('audio/');
    await admin.patch(`/api/audios/${b?.id}`, { active: true });
  });
});

describe('chamar enviando o áudio sorteado', () => {
  it('sorteia um áudio ativo e envia como mensagem de voz para o lead', async () => {
    const before = fake.calls.filter((c) => c.url.startsWith('/message/sendWhatsAppAudio')).length;
    const r = await call(ana, leads[0] as number);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as LeadChatResult;
    expect(body.audio?.sent).toBe(true);
    expect(['Apresentação A', 'Apresentação B']).toContain(body.audio?.label);

    const after = fake.calls.filter((c) => c.url.startsWith('/message/sendWhatsAppAudio')).length;
    expect(after).toBe(before + 1);

    const msgs = await messagesOf(body.conversationId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: 'audio', fromMe: true });

    // O lead é marcado sozinho como chamado (mensagem enviada).
    const { lead } = (await ana.get(`/api/leads/${leads[0]}`)).json() as LeadDetail;
    expect(lead.status).toBe('chamado');
    expect(lead.result).toBe('enviado');
  });

  it('não repete o mesmo áudio em seguida no mesmo número', async () => {
    const first = ((await call(ana, leads[1] as number)).json() as LeadChatResult).audio?.label;
    const second = ((await call(ana, leads[2] as number)).json() as LeadChatResult).audio?.label;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('sem áudio salvo: abre a conversa mesmo assim e avisa', async () => {
    for (const a of await listAudios(admin)) await admin.post(`/api/audios/${a.id}/delete`, {});
    expect(await listAudios(admin)).toEqual([]);

    const r = await call(ana, leads[3] as number);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as LeadChatResult;
    expect(body.conversationId).toBeGreaterThan(0);
    expect(body.audio).toMatchObject({ sent: false, reason: 'sem_audios' });
    expect(await messagesOf(body.conversationId)).toEqual([]);
  });

  it('excluir tira do sorteio e some da lista', async () => {
    await uploadAudio(admin, 'Nova', 12);
    const [nova] = await listAudios(admin);
    expect((await admin.post(`/api/audios/${nova?.id}/delete`, {})).statusCode).toBe(204);
    expect(await listAudios(admin)).toEqual([]);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', 'in', ['criou_audio', 'excluiu_audio'])
      .execute();
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });
});
