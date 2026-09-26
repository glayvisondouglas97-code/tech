import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { seedTodayUsage } from './db';

/**
 * Campanha como operação (Fase 6), pela tela: filtros do público com a prévia do servidor, agendar para uma data futura,
 * editar, pausar e encerrar uma campanha agendada, "Iniciar agora" fora do horário, capacidade real por número (14/20,
 * 7/20 e 20/20), erro e carregamento da prévia e o tema escuro. Roda depois do fluxo principal (que cria a lista
 * "Campanha E2E" e o número whatsapp-01). O servidor de teste não roda o job de envio: o que se prova aqui é a TELA e o
 * que o servidor calcula; o envio, o horário e a cota são provados nos testes de integração, com relógio injetado.
 */

const ADMIN = { email: 'gestora@e2e.teste', password: 'senha-e2e-123' };
const WEBHOOK_TOKEN = 'token-do-webhook-e2e';
const SHOTS = resolve('test-results/telas');
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
}

function tinyWav(): Buffer {
  const dataSize = 800;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(8000, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  buf.fill(128, 44);
  return buf;
}

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

const pad = (n: number) => String(n).padStart(2, '0');
const numberOf = (text: string | null) => Number((text ?? '').replace(/\D/g, ''));

/** Hoje em São Paulo (AAAA-MM-DD) e o mês seguinte: primeiro e último dia, e o dia da semana do primeiro (ISO, 1 a 7). */
function calendarFacts() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const [y, m] = today.split('-').map(Number) as [number, number];
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  const start = `${ny}-${pad(nm)}-01`;
  const end = `${ny}-${pad(nm)}-${pad(new Date(Date.UTC(ny, nm, 0)).getUTCDate())}`;
  const br = (ymd: string) => ymd.split('-').reverse().join('/');
  const sunday0 = new Date(`${start}T12:00:00Z`).getUTCDay();
  const daysUntil = Math.round(
    (Date.parse(`${start}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  return {
    today,
    start,
    end,
    startBr: br(start),
    endBr: br(end),
    weekday: sunday0 === 0 ? 7 : sunday0,
    daysUntil,
  };
}

test.describe.configure({ mode: 'serial' });

interface UsageInfo {
  total: number;
  limit: number;
  remaining: number;
  limitReached: boolean;
}
interface InstanceRow {
  id: number;
  name: string;
  nickname: string | null;
  status: string;
  usage: UsageInfo;
}

let admin: Page;
let headers: Record<string, string> = {};
let automationId = 0;
let listId = '';
const numbers: Record<'a14' | 'a07' | 'a20', InstanceRow> = {} as never;

const csrfOf = async () => (await (await admin.request.get('/api/auth/me')).json()).csrfToken as string;
const instancesOf = async (): Promise<InstanceRow[]> => (await admin.request.get('/api/instances')).json();
const dialog = () => admin.getByRole('dialog', { name: /^(Nova|Editar) campanha$/ });
const summary = () => admin.getByRole('dialog', { name: 'Resumo da campanha' });
const panel = () => admin.getByRole('region', { name: 'Campanha' });

async function connect(name: string, state: 'open' | 'close') {
  const r = await admin.request.post('/webhook/evolution', {
    headers: { 'x-webhook-token': WEBHOOK_TOKEN },
    data: { event: 'connection.update', instance: name, data: { state } },
  });
  expect(r.ok(), await r.text()).toBe(true);
}

async function newNumber(
  nickname: string,
  usage: { manual: number; automatic: number },
): Promise<InstanceRow> {
  const created = await admin.request.post('/api/instances', { headers, data: { nickname } });
  expect(created.ok(), await created.text()).toBe(true);
  const row = (await created.json()) as InstanceRow;
  await connect(row.name, 'open');
  await seedTodayUsage(row.name, usage);
  return ((await instancesOf()).find((i) => i.id === row.id) as InstanceRow) ?? row;
}

async function openNewCampaign() {
  await admin.goto(`/automacoes/${automationId}`);
  await panel().getByRole('button', { name: 'Nova campanha' }).click();
  await expect(dialog()).toBeVisible();
  await dialog().getByLabel('Lista de leads').selectOption(listId);
}

const numberBox = (nickname: string) => dialog().locator('li.auto-number').filter({ hasText: nickname });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  admin = await context.newPage();
  await admin.goto('/entrar');
  await admin.getByLabel('E-mail').fill(ADMIN.email);
  await admin.getByLabel('Senha').fill(ADMIN.password);
  await admin.getByRole('button', { name: 'Entrar' }).click();
  await expect(admin).toHaveURL(/\/chamar$/);
  headers = { 'x-csrf-token': await csrfOf() };

  for (const label of ['Agenda — áudio 1', 'Agenda — áudio 2']) {
    const audio = await admin.request.post(`/api/audios?label=${encodeURIComponent(label)}&seconds=1`, {
      headers: { ...headers, 'content-type': 'audio/wav' },
      data: tinyWav(),
    });
    expect(audio.ok(), await audio.text()).toBe(true);
  }
  const created = await admin.request.post('/api/automations', {
    headers,
    data: { name: 'Prospecção agendada', trigger: 'manual' },
  });
  automationId = (await created.json()).id;
  const step = await admin.request.post(`/api/automations/${automationId}/steps`, {
    headers,
    data: { actionType: 'send_audio', delaySeconds: 0, audioMode: 'random', conditions: [] },
  });
  expect(step.status(), await step.text()).toBe(201);
  const active = await admin.request.patch(`/api/automations/${automationId}/status`, {
    headers,
    data: { status: 'active' },
  });
  expect(active.status(), await active.text()).toBe(200);

  const lists = (await (await admin.request.get('/api/lists?archived=0')).json()) as {
    id: string;
    name: string;
  }[];
  listId = lists.find((l) => l.name === 'Campanha E2E')?.id as string;
  expect(listId).toBeTruthy();

  // Três números conectados com o uso de hoje já feito: 14/20, 7/20 e 20/20 (manuais e automáticos somados).
  numbers.a14 = await newNumber('Agenda 14', { manual: 8, automatic: 6 });
  numbers.a07 = await newNumber('Agenda 07', { manual: 2, automatic: 5 });
  numbers.a20 = await newNumber('Agenda 20', { manual: 7, automatic: 13 });
});

test.afterAll(async () => {
  // Não deixa campanha viva nem número extra para os outros testes (eles esperam só o número do fluxo principal).
  const list = (await (await admin.request.get(`/api/automations/${automationId}/campaigns`)).json()) as {
    id: number;
    status: string;
  }[];
  for (const c of list.filter((x) => x.status === 'active' || x.status === 'paused')) {
    await admin.request.post(`/api/automations/${automationId}/campaigns/${c.id}/stop`, {
      headers,
      data: {},
    });
  }
  for (const n of Object.values(numbers)) {
    await admin.request.post(`/api/instances/${n.id}/delete`, { headers, data: { confirm: 'EXCLUIR' } });
  }
});

test('filtros do público: DDD, situação, telefone e "chamado antes" mudam a prévia e concordam com o servidor', async () => {
  await openNewCampaign();
  const dlg = dialog();
  await numberBox('Agenda 07').getByRole('checkbox').check();
  await expect(dlg.getByTestId('preview-total')).toBeVisible({ timeout: 20_000 });
  const total = numberOf(await dlg.getByTestId('preview-total').textContent());
  const all = numberOf(await dlg.getByTestId('preview-eligible').textContent());
  expect(all).toBeGreaterThan(0);
  expect(all).toBeLessThanOrEqual(total);
  await shot(admin, 'c12-campanha-configuracao');

  const apiEligible = async (filters: Record<string, unknown>) => {
    const r = await admin.request.post(`/api/automations/${automationId}/campaigns/preview`, {
      headers,
      data: {
        listId,
        instanceIds: [numbers.a07.id],
        windowStart: '10:00',
        windowEnd: '16:00',
        dailyLimitPerNumber: 20,
        filters,
      },
    });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).audience.eligible as number;
  };
  const uiEligible = () => dlg.getByTestId('preview-eligible');

  await dlg.getByText('Filtros do público (opcional)').click();
  // Um DDD que não existe na lista: ninguém entra, o aviso aparece e o botão de seguir fica desligado.
  await dlg.getByTestId('filtro-ddd').fill('99');
  await expect(uiEligible()).toHaveText('0', { timeout: 20_000 });
  await expect(dlg.getByText(/Não há leads elegíveis com esta lista e estes filtros/)).toBeVisible();
  await expect(dlg.getByTestId('preview-filtered')).not.toHaveText('0');
  await expect(dlg.getByRole('button', { name: 'Revisar e continuar' })).toBeDisabled();
  expect(await apiEligible({ ddd: ['99'] })).toBe(0);

  // Um DDD que existe: procura na própria lista (pela API) um que separe o público, e a tela mostra o mesmo número.
  let ddd = '';
  let dddCount = 0;
  for (const candidate of ['11', '21', '31', '41', '47', '51', '61', '71', '81', '85']) {
    const n = await apiEligible({ ddd: [candidate] });
    if (n > 0 && n < all) {
      ddd = candidate;
      dddCount = n;
      break;
    }
  }
  if (ddd) {
    await dlg.getByTestId('filtro-ddd').fill(ddd);
    await expect(uiEligible()).toHaveText(new RegExp(`^${dddCount.toLocaleString('pt-BR')}$`), {
      timeout: 20_000,
    });
  }
  await dlg.getByTestId('filtro-ddd').fill('');

  // Situação (incluir quem já foi chamado), tipo de telefone e "chamado antes": a tela sempre bate com o servidor.
  await dlg.getByTestId('filtro-situacao-chamado').check();
  await expect(uiEligible()).toHaveText(
    (await apiEligible({ status: ['pendente', 'chamado'] })).toLocaleString('pt-BR'),
    { timeout: 20_000 },
  );
  await dlg.getByTestId('filtro-situacao-chamado').uncheck();
  await dlg.getByTestId('filtro-telefone-fixo').check();
  await expect(uiEligible()).toHaveText(
    (await apiEligible({ phoneType: ['fixo'] })).toLocaleString('pt-BR'),
    {
      timeout: 20_000,
    },
  );
  await dlg.getByTestId('filtro-telefone-fixo').uncheck();
  await dlg.getByTestId('filtro-chamado-antes').selectOption('never');
  await expect(uiEligible()).toHaveText(
    (await apiEligible({ calledBefore: 'never' })).toLocaleString('pt-BR'),
    {
      timeout: 20_000,
    },
  );
  await dlg.getByTestId('filtro-chamado-antes').selectOption('any');
  await expect(uiEligible()).toHaveText(all.toLocaleString('pt-BR'), { timeout: 20_000 });
  await noSideScroll(admin);
  await dlg.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dlg).toBeHidden();
});

test('agendar campanha: fica Agendada com datas, dias e calendário, e nada é enviado antes da data', async () => {
  const f = calendarFacts();
  await openNewCampaign();
  const dlg = dialog();
  await numberBox('Agenda 07').getByRole('checkbox').check();
  await dlg.getByTestId('quando-agendar').check();
  await dlg.getByTestId('campo-data-inicio').fill(f.start);
  await dlg.getByTestId('campo-data-fim').fill(f.end);
  // A prévia (do servidor) já diz que a campanha ficará agendada e mostra o calendário.
  await expect(dlg.getByTestId('previa-agenda')).toHaveText(`Agendada: começa em ${f.startBr}.`, {
    timeout: 20_000,
  });
  await expect(dlg.getByTestId(`cal-${f.today}`)).toHaveAttribute('data-state', 'before_start');
  if (f.daysUntil <= 13) {
    await expect(dlg.getByTestId(`cal-${f.start}`)).toHaveAttribute(
      'data-state',
      f.weekday <= 5 ? 'runs' : 'not_allowed',
    );
  }
  await expect(dlg.getByTestId('estimativa')).toContainText('Estimativa aproximada');
  await shot(admin, 'c13-campanha-agendar');

  await dlg.getByRole('button', { name: 'Revisar e continuar' }).click();
  const resumo = summary();
  await expect(resumo.getByTestId('resumo-periodo')).toHaveText(`${f.startBr} a ${f.endBr}`);
  await expect(resumo.getByText('Seg–Sex')).toBeVisible();
  await expect(resumo.getByText('10:00 às 16:00')).toBeVisible();
  await expect(resumo.getByText(/24 horas depois de um primeiro contato automático/)).toBeVisible();
  await expect(
    resumo.getByText(/A campanha fica agendada e nada é enviado antes da data de início/),
  ).toBeVisible();
  await shot(admin, 'c14-campanha-resumo-agendada');
  await resumo.getByRole('button', { name: 'Agendar campanha' }).click();
  await expect(admin.getByText(/Campanha agendada/)).toBeVisible();

  const live = admin.getByTestId('campanha-viva');
  await expect(admin.getByTestId('campanha-status')).toHaveText('Agendada');
  await expect(live.getByTestId('campanha-agendada')).toContainText(`Agendada: começa em ${f.startBr}.`);
  await expect(live.getByTestId('campanha-inicio')).toHaveText(f.startBr);
  await expect(live.getByTestId('campanha-fim')).toHaveText(f.endBr);
  await expect(live.getByTestId('campanha-dias')).toHaveText('Seg–Sex');
  await expect(live.getByTestId('calendario')).toBeVisible();
  await shot(admin, 'c15-campanha-agendada');

  // No servidor: ativa, com data inicial e final, e nenhuma participação nem mensagem.
  const list = await (await admin.request.get(`/api/automations/${automationId}/campaigns`)).json();
  expect(list[0]).toMatchObject({
    status: 'active',
    startDate: f.start,
    endDate: f.end,
    daysOfWeek: [1, 2, 3, 4, 5],
    cooldownHours: 24,
    schedule: { state: 'scheduled' },
  });
  expect(await (await admin.request.get(`/api/automations/${automationId}/runs`)).json()).toEqual([]);
  await admin.reload();
  await expect(admin.getByTestId('campanha-status')).toHaveText('Agendada');
});

test('editar uma campanha agendada: vale só o que mudou (cooldown), a agenda fica', async () => {
  const f = calendarFacts();
  await panel().getByTestId('editar-campanha').click();
  const dlg = dialog();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId('campo-cooldown')).toHaveValue('24');
  await expect(dlg.getByTestId('campo-data-inicio')).toHaveValue(f.start);
  await expect(dlg.getByRole('button', { name: 'Salvar alterações' })).toBeDisabled(); // nada mudou
  await dlg.getByTestId('campo-cooldown').fill('48');
  await expect(dlg.getByRole('button', { name: 'Salvar alterações' })).toBeEnabled({ timeout: 20_000 });
  await dlg.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(admin.getByText(/Campanha atualizada/)).toBeVisible();
  const live = admin.getByTestId('campanha-viva');
  await expect(live.getByText('48 horas', { exact: true })).toBeVisible();
  await expect(live.getByTestId('campanha-inicio')).toHaveText(f.startBr);
  const list = await (await admin.request.get(`/api/automations/${automationId}/campaigns`)).json();
  expect(list[0]).toMatchObject({ cooldownHours: 48, startDate: f.start, endDate: f.end });
});

test('pausar e retomar a campanha agendada; encerrar não volta', async () => {
  await panel().getByRole('button', { name: 'Pausar' }).click();
  await expect(admin.getByText('Campanha pausada.')).toBeVisible();
  await expect(admin.getByTestId('campanha-status')).toHaveText('Pausada');
  await expect(panel().getByText(/a agenda e o histórico continuam guardados/)).toBeVisible();
  await panel().getByRole('button', { name: 'Retomar' }).click();
  await expect(admin.getByText('Campanha retomada.')).toBeVisible();
  await expect(admin.getByTestId('campanha-status')).toHaveText('Agendada');
  await panel().getByRole('button', { name: 'Encerrar', exact: true }).click();
  await admin
    .getByRole('dialog', { name: 'Encerrar campanha?' })
    .getByRole('button', { name: 'Encerrar campanha' })
    .click();
  await expect(admin.getByText(/Campanha encerrada/)).toBeVisible();
  await expect(panel().getByText('Última campanha')).toBeVisible();
});

test('"Iniciar agora" fora do horário não envia: espera a próxima janela válida', async () => {
  await openNewCampaign();
  const dlg = dialog();
  await numberBox('Agenda 07').getByRole('checkbox').check();
  // Uma janela de um minuto à meia-noite: a qualquer hora do teste ela já passou (ou só abre de novo amanhã).
  await dlg.getByLabel('Horário de trabalho: das').fill('00:00');
  await dlg.getByLabel('até', { exact: true }).fill('00:01');
  await dlg.getByRole('button', { name: 'Todos os dias' }).click();
  await expect(dlg.getByTestId('previa-agenda')).toContainText('Fora do horário: a janela fechou às 00:01.', {
    timeout: 20_000,
  });
  await dlg.getByRole('button', { name: 'Revisar e continuar' }).click();
  await expect(
    summary().getByText(/Fora do horário de trabalho, a campanha espera a próxima janela válida/),
  ).toBeVisible();
  await summary().getByRole('button', { name: 'Iniciar campanha' }).click();
  await expect(admin.getByText(/Campanha iniciada/)).toBeVisible();

  const live = admin.getByTestId('campanha-viva');
  await expect(admin.getByTestId('campanha-status')).toHaveText('Ativa');
  await expect(live.getByTestId('campanha-espera')).toContainText(
    'Fora do horário: a janela fechou às 00:01.',
  );
  await expect(live.getByTestId('campanha-espera')).toContainText(/Próxima janela: amanhã, 00:00/);
  await expect(live.getByTestId('campanha-total')).toHaveText('0'); // nada entrou: a janela de hoje já passou
  expect(await (await admin.request.get(`/api/automations/${automationId}/runs`)).json()).toEqual([]);
  await shot(admin, 'c16-campanha-fora-do-horario');
  await panel().getByRole('button', { name: 'Encerrar', exact: true }).click();
  await admin
    .getByRole('dialog', { name: 'Encerrar campanha?' })
    .getByRole('button', { name: 'Encerrar campanha' })
    .click();
  await expect(admin.getByText(/Campanha encerrada/)).toBeVisible();
});

test('capacidade real: 14/20, 7/20 e 20/20 por número, e o desconectado fica fora até reconectar', async () => {
  await openNewCampaign();
  const dlg = dialog();
  const label = async (n: InstanceRow) => dlg.getByTestId(`campanha-cota-${n.id}`);
  await expect(await label(numbers.a14)).toHaveText('14/20 hoje · disponível 6');
  await expect(await label(numbers.a07)).toHaveText('7/20 hoje · disponível 13');
  await expect(await label(numbers.a20)).toHaveText('Limite diário atingido');
  await dlg.getByRole('button', { name: 'Marcar os conectados' }).click();

  const open = (await instancesOf()).filter((i) => i.status === 'open');
  const remaining = open.reduce((sum, i) => sum + i.usage.remaining, 0);
  await expect(dlg.getByTestId('preview-connected')).toHaveText(`${open.length} de ${open.length}`, {
    timeout: 20_000,
  });
  await expect(dlg.getByTestId('preview-available')).toContainText(`${remaining} contato`);
  await expect(dlg.getByTestId('preview-capacity')).toContainText(`${open.length * 20} leads`);
  await expect(dlg.getByTestId(`preview-numero-${numbers.a14.id}`)).toContainText(
    '14/20 hoje · disponível 6',
  );
  await expect(dlg.getByTestId(`preview-numero-${numbers.a14.id}`)).toContainText(
    '8 manuais · 6 automáticos',
  );
  await expect(dlg.getByTestId(`preview-numero-${numbers.a07.id}`)).toContainText(
    '7/20 hoje · disponível 13',
  );
  await expect(dlg.getByTestId(`preview-numero-${numbers.a20.id}`)).toContainText('Limite diário atingido');
  await shot(admin, 'c17-campanha-capacidade');
  await dlg.getByRole('button', { name: 'Cancelar' }).click();

  // Um número que cai: sai do rodízio e da capacidade; ao reconectar, volta.
  await connect(numbers.a07.name, 'close');
  await openNewCampaign();
  await expect(numberBox('Agenda 07').getByText('Desconectado', { exact: true })).toBeVisible();
  await dialog().getByRole('button', { name: 'Marcar os conectados' }).click();
  await expect(numberBox('Agenda 07').getByRole('checkbox')).not.toBeChecked();
  await expect(dialog().getByTestId('preview-connected')).toHaveText(
    `${open.length - 1} de ${open.length - 1}`,
    {
      timeout: 20_000,
    },
  );
  await dialog().getByRole('button', { name: 'Cancelar' }).click();
  await connect(numbers.a07.name, 'open');
  await openNewCampaign();
  await expect(numberBox('Agenda 07').getByText('Conectado', { exact: true })).toBeVisible();
  await dialog().getByRole('button', { name: 'Cancelar' }).click();
});

test('carregando e erro da prévia aparecem em palavras, e o botão de seguir fica desligado', async () => {
  await openNewCampaign();
  const dlg = dialog();
  await admin.route('**/api/automations/*/campaigns/preview', async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Falha simulada na prévia.' }),
    });
  });
  await numberBox('Agenda 14').getByRole('checkbox').check();
  await expect(dlg.getByRole('status', { name: 'Calculando' })).toBeVisible();
  await expect(dlg.getByRole('alert').filter({ hasText: 'Falha simulada na prévia.' })).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Revisar e continuar' })).toBeDisabled();
  await admin.unroute('**/api/automations/*/campaigns/preview');
  await dlg.getByRole('button', { name: 'Cancelar' }).click();
});

test('tema claro e escuro: a janela, o resumo e o painel cabem, sem rolar para o lado', async () => {
  for (const scheme of ['light', 'dark'] as const) {
    await admin.emulateMedia({ colorScheme: scheme });
    await openNewCampaign();
    const dlg = dialog();
    await numberBox('Agenda 14').getByRole('checkbox').check();
    await expect(dlg.getByTestId('preview-eligible')).toBeVisible({ timeout: 20_000 });
    await noSideScroll(admin);
    await shot(admin, `c18-campanha-dialogo-${scheme}`);
    await dlg.getByRole('button', { name: 'Revisar e continuar' }).click();
    await expect(summary().getByTestId('resumo-final')).toBeVisible();
    await noSideScroll(admin);
    await shot(admin, `c19-campanha-resumo-${scheme}`);
    await summary().getByRole('button', { name: 'Cancelar' }).click();
  }
  await admin.emulateMedia({ colorScheme: 'light' });
});
