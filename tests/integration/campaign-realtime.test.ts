import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advanceCampaigns } from '../../src/server/modules/automations/queue';
import { publishCampaignChange } from '../../src/server/modules/whatsapp/realtime';
import { at, campaignKit } from '../campaign-kit';
import { type Client, createUser, loginAs } from '../helpers';

// Tempo real das campanhas: a MESMA conexão Socket.io que já leva as conversas e os números. O aviso leva só os ids (os dados
// continuam vindo pela API, com a permissão de sempre) e só chega a quem gerencia automações.

const k = campaignKit();
const sockets: Socket[] = [];
let baseUrl = '';
let supervisor: Client;

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
  await k.t.app.listen({ port: 0, host: '127.0.0.1' });
  const address = k.t.app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  supervisor = await loginAs(k.t.app, await createUser(k.t.db, { name: 'Sílvia', role: 'supervisor' }));
});

afterAll(() => {
  for (const s of sockets) s.close();
});

async function fresh() {
  await k.uploadAudio('Áudio');
  const automationId = await k.makeAutomation([{ audio: 'random' }]);
  const list = await k.newList(6);
  return { automationId, listId: list.listId };
}

describe('campanhas em tempo real (Socket.io)', () => {
  it('iniciar, editar, pausar, retomar e encerrar avisam quem gerencia — e só ele', async () => {
    const { automationId, listId } = await fresh();
    const [admin, ana, sup] = await Promise.all([live(k.admin), live(k.ana), live(supervisor)]);
    const started = await k.admin.post(`/api/automations/${automationId}/campaigns`, {
      listId,
      instanceIds: [k.numbers[0]],
      startDate: '2026-03-10',
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    });
    expect(started.statusCode, started.body).toBe(201);
    const id = started.json().id as number;
    const forThis = (d: { campaignId: number; automationId: number }) =>
      d.campaignId === id && d.automationId === automationId;

    await until(() => admin.got('campaign:updated', forThis));
    admin.clear();
    const base = `/api/automations/${automationId}/campaigns/${id}`;
    expect((await k.admin.patch(base, { cooldownHours: 12 })).statusCode).toBe(200);
    await until(() => admin.got('campaign:updated', forThis));
    admin.clear();
    expect((await k.admin.post(`${base}/pause`, {})).statusCode).toBe(200);
    await until(() => admin.got('campaign:updated', forThis));
    admin.clear();
    expect((await k.admin.post(`${base}/resume`, {})).statusCode).toBe(200);
    await until(() => admin.got('campaign:updated', forThis));
    admin.clear();
    expect((await k.admin.post(`${base}/stop`, {})).statusCode).toBe(200);
    await until(() => admin.got('campaign:updated', forThis));

    await pause();
    // Atendente e supervisor não recebem: não gerenciam automações.
    expect(ana.events.filter((e) => e.event === 'campaign:updated')).toEqual([]);
    expect(sup.events.filter((e) => e.event === 'campaign:updated')).toEqual([]);
  });

  it('o aviso leva SÓ os ids (nenhum dado de lead, número ou mensagem)', async () => {
    const { automationId, listId } = await fresh();
    const admin = await live(k.admin);
    const detail = await k.startCampaignAt(at(9, 0), automationId, listId, [k.numbers[0]]);
    await publishCampaignChange([detail.id]);
    await until(() => admin.got('campaign:updated'));
    const event = admin.events.find((e) => e.event === 'campaign:updated');
    expect(event?.data).toEqual({ automationId, campaignId: detail.id });
  });

  it('o ciclo da fila avisa quando reserva um lead (o mesmo aviso que o job do scheduler publica)', async () => {
    const { automationId, listId } = await fresh();
    const admin = await live(k.admin);
    const detail = await k.startCampaignAt(at(9, 0), automationId, listId, [k.numbers[0]]);
    const tick = await advanceCampaigns(k.t.db, { now: at(9, 0) });
    expect(tick.campaignIds).toContain(detail.id);
    await publishCampaignChange(tick.campaignIds);
    await until(() =>
      admin.got('campaign:updated', (d: { campaignId: number }) => d.campaignId === detail.id),
    );
  });

  it('sem ids não avisa ninguém, e id que não existe (campanha apagada) é ignorado sem erro', async () => {
    const admin = await live(k.admin);
    await publishCampaignChange([]);
    await publishCampaignChange([987654]);
    await pause();
    expect(admin.events.filter((e) => e.event === 'campaign:updated')).toEqual([]);
  });
});
