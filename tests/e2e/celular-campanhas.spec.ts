import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * Campanha de automação no celular (Pixel 7): o painel e a janela "Nova campanha" não rolam para o lado, os
 * botões cabem na tela e têm tamanho para o dedo, e os números aparecem em cartões. Roda depois dos testes do
 * computador (que deixam a lista "Campanha E2E" e o número conectado). O servidor de teste não roda o job de envio.
 */

const ADMIN = { email: 'gestora@e2e.teste', password: 'senha-e2e-123' };
const SHOTS = resolve('test-results/telas');
mkdirSync(SHOTS, { recursive: true });

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

test('campanha de automação no celular', async ({ page }) => {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(ADMIN.email);
  await page.getByLabel('Senha').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/chamar$/);

  const csrf = (await (await page.request.get('/api/auth/me')).json()).csrfToken;
  const headers = { 'x-csrf-token': csrf };
  const audio = await page.request.post('/api/audios?label=Celular%20%E2%80%94%20%C3%A1udio&seconds=1', {
    headers: { ...headers, 'content-type': 'audio/wav' },
    data: tinyWav(),
  });
  expect(audio.ok(), await audio.text()).toBe(true);
  const created = await page.request.post('/api/automations', {
    headers,
    data: { name: 'Campanha no celular', trigger: 'manual' },
  });
  const id = (await created.json()).id;
  await page.request.post(`/api/automations/${id}/steps`, {
    headers,
    data: { actionType: 'send_audio', delaySeconds: 0, audioMode: 'random', conditions: [] },
  });
  const active = await page.request.patch(`/api/automations/${id}/status`, {
    headers,
    data: { status: 'active' },
  });
  expect(active.status(), await active.text()).toBe(200);

  const lists = (await (await page.request.get('/api/lists?archived=0')).json()) as {
    id: string;
    name: string;
  }[];
  const list = lists.find((l) => l.name === 'Campanha E2E');
  expect(list).toBeTruthy();
  const instances = (await (await page.request.get('/api/instances')).json()) as {
    id: number;
    status: string;
  }[];
  const number = instances.find((i) => i.status === 'open');
  expect(number).toBeTruthy();

  const width = page.viewportSize()?.width ?? 412;
  await page.goto(`/automacoes/${id}`);
  await expect(page.getByRole('heading', { name: 'Campanha no celular', level: 1 })).toBeVisible();
  const panel = page.getByRole('region', { name: 'Campanha' });
  await expect(panel.getByText('Nenhuma campanha em andamento')).toBeVisible();
  await noSideScroll(page);

  // A janela de iniciar cabe na tela (folha que sobe de baixo), sem rolar para o lado, e o botão fica ao alcance.
  await panel.getByRole('button', { name: 'Nova campanha' }).tap();
  const dialog = page.getByRole('dialog', { name: 'Nova campanha' });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(450);
  const box = await dialog.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(width);
  await dialog.getByLabel('Lista de leads').selectOption(list?.id as string);
  await dialog.getByRole('button', { name: 'Marcar os conectados' }).tap();
  await expect(dialog.getByTestId('preview-eligible')).toBeVisible({ timeout: 20_000 });
  await noSideScroll(page);
  await page.screenshot({ path: resolve(SHOTS, 'c10-celular-dialogo-campanha.png'), fullPage: false });
  const submit = dialog.getByRole('button', { name: 'Revisar e continuar' });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
  // Cada número mostra a capacidade de hoje (do servidor) e cabe na tela.
  await expect(dialog.getByTestId(/campanha-cota-/).first()).toContainText(/hoje|Limite/);
  await noSideScroll(page);
  await dialog.getByLabel('Horário de trabalho: das').fill('00:00');
  await dialog.getByLabel('até', { exact: true }).fill('23:59');
  await dialog.getByRole('button', { name: 'Todos os dias' }).tap();
  await expect(submit).toBeEnabled();
  await submit.tap();
  // O resumo final também cabe na tela do celular, com os botões ao alcance.
  const resumo = page.getByRole('dialog', { name: 'Resumo da campanha' });
  await expect(resumo.getByTestId('resumo-final')).toBeVisible();
  await noSideScroll(page);
  const start = resumo.getByRole('button', { name: 'Iniciar campanha' });
  await start.scrollIntoViewIfNeeded();
  await expect(start).toBeInViewport();
  await start.tap();
  await expect(page.getByText(/Campanha iniciada/)).toBeVisible();

  // O painel: situação, contadores e o cartão de cada número, sem rolar para o lado; botões com tamanho para o dedo.
  const live = page.getByTestId('campanha-viva');
  await expect(live).toBeVisible();
  await expect(page.getByTestId('campanha-status')).toHaveText('Ativa');
  await expect(live.getByTestId(/campanha-numero-/).first()).toBeVisible();
  await expect(live.getByTestId(/campanha-uso-/).first()).toHaveText(/Total: \d+\/\d+ hoje/);
  // O número que já fez 20 contatos hoje (preparado no teste do computador) aparece como indisponível.
  await expect(live.getByTestId(/campanha-limite-/).first()).toContainText('Limite diário atingido');
  await noSideScroll(page);
  for (const name of ['Pausar', 'Encerrar']) {
    const button = live.getByRole('button', { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    const b = await button.boundingBox();
    expect(b, name).not.toBeNull();
    expect((b?.x ?? 0) + (b?.width ?? 0), `${name} cabe na tela`).toBeLessThanOrEqual(width);
    expect(b?.height ?? 0, `${name} tem altura para o dedo`).toBeGreaterThanOrEqual(34);
  }
  await page.screenshot({ path: resolve(SHOTS, 'c11-celular-campanha.png'), fullPage: true });

  // Pausar e encerrar tocando.
  await live.getByRole('button', { name: 'Pausar', exact: true }).tap();
  await expect(page.getByTestId('campanha-status')).toHaveText('Pausada');
  await live.getByRole('button', { name: 'Encerrar', exact: true }).tap();
  const confirm = page.getByRole('dialog', { name: 'Encerrar campanha?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Encerrar campanha' }).tap();
  await expect(page.getByText(/Campanha encerrada/)).toBeVisible();
  await expect(panel.getByText('Última campanha')).toBeVisible();
  await noSideScroll(page);
});

test('agendar campanha no celular: dias, datas, calendário e resumo cabem na tela', async ({ page }) => {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(ADMIN.email);
  await page.getByLabel('Senha').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/chamar$/);

  const csrf = (await (await page.request.get('/api/auth/me')).json()).csrfToken;
  const headers = { 'x-csrf-token': csrf };
  const created = await page.request.post('/api/automations', {
    headers,
    data: { name: 'Agenda no celular', trigger: 'manual' },
  });
  const id = (await created.json()).id;
  await page.request.post(`/api/automations/${id}/steps`, {
    headers,
    data: { actionType: 'send_audio', delaySeconds: 0, audioMode: 'random', conditions: [] },
  });
  const active = await page.request.patch(`/api/automations/${id}/status`, {
    headers,
    data: { status: 'active' },
  });
  expect(active.status(), await active.text()).toBe(200);
  const lists = (await (await page.request.get('/api/lists?archived=0')).json()) as {
    id: string;
    name: string;
  }[];
  const list = lists.find((l) => l.name === 'Campanha E2E');
  expect(list).toBeTruthy();

  // Primeiro e último dia do mês seguinte (AAAA-MM-DD) e o dia de hoje em São Paulo.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const [y, m] = today.split('-').map(Number) as [number, number];
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  const pad = (n: number) => String(n).padStart(2, '0');
  const start = `${ny}-${pad(nm)}-01`;
  const end = `${ny}-${pad(nm)}-${pad(new Date(Date.UTC(ny, nm, 0)).getUTCDate())}`;
  const br = (ymd: string) => ymd.split('-').reverse().join('/');

  const width = page.viewportSize()?.width ?? 412;
  await page.goto(`/automacoes/${id}`);
  const panel = page.getByRole('region', { name: 'Campanha' });
  await panel.getByRole('button', { name: 'Nova campanha' }).tap();
  const dialog = page.getByRole('dialog', { name: 'Nova campanha' });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(450);
  await dialog.getByLabel('Lista de leads').selectOption(list?.id as string);
  await dialog.getByRole('button', { name: 'Marcar os conectados' }).tap();

  // Os dias da semana são botões com tamanho para o dedo, e todos cabem na largura da tela.
  const chips = dialog.locator('.camp-day');
  await expect(chips).toHaveCount(7);
  for (let i = 0; i < 7; i++) {
    const chip = chips.nth(i);
    await chip.scrollIntoViewIfNeeded();
    const box = await chip.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0), `dia ${i + 1} cabe na tela`).toBeLessThanOrEqual(width);
    expect(box?.height ?? 0, `dia ${i + 1} tem altura para o dedo`).toBeGreaterThanOrEqual(36);
  }
  await dialog.getByTestId('quando-agendar').check();
  await dialog.getByTestId('campo-data-inicio').fill(start);
  await dialog.getByTestId('campo-data-fim').fill(end);
  await expect(dialog.getByTestId('previa-agenda')).toHaveText(`Agendada: começa em ${br(start)}.`, {
    timeout: 20_000,
  });
  const calendar = dialog.getByTestId('calendario');
  await calendar.scrollIntoViewIfNeeded();
  await expect(calendar).toBeVisible();
  await expect(calendar.locator('li')).toHaveCount(14);
  await noSideScroll(page);
  await page.screenshot({ path: resolve(SHOTS, 'c20-celular-agenda-calendario.png'), fullPage: false });

  const next = dialog.getByRole('button', { name: 'Revisar e continuar' });
  await next.scrollIntoViewIfNeeded();
  await next.tap();
  const resumo = page.getByRole('dialog', { name: 'Resumo da campanha' });
  await expect(resumo.getByTestId('resumo-periodo')).toHaveText(`${br(start)} a ${br(end)}`);
  await noSideScroll(page);
  await page.screenshot({ path: resolve(SHOTS, 'c21-celular-agenda-resumo.png'), fullPage: false });
  const schedule = resumo.getByRole('button', { name: 'Agendar campanha' });
  await schedule.scrollIntoViewIfNeeded();
  await expect(schedule).toBeInViewport();
  await schedule.tap();
  await expect(page.getByText(/Campanha agendada/)).toBeVisible();

  const live = page.getByTestId('campanha-viva');
  await expect(page.getByTestId('campanha-status')).toHaveText('Agendada');
  await expect(live.getByTestId('campanha-agendada')).toBeVisible();
  await noSideScroll(page);
  await page.screenshot({ path: resolve(SHOTS, 'c22-celular-agendada.png'), fullPage: true });
  // Os contadores e o calendário ficam legíveis no celular (cartões, sem tabela larga).
  await expect(live.getByTestId('calendario')).toBeVisible();
  await live.getByRole('button', { name: 'Encerrar', exact: true }).tap();
  await page
    .getByRole('dialog', { name: 'Encerrar campanha?' })
    .getByRole('button', { name: 'Encerrar campanha' })
    .tap();
  await expect(page.getByText(/Campanha encerrada/)).toBeVisible();
});
