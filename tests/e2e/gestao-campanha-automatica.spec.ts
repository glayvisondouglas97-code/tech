import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * Aba Automações = a campanha automática, pré-definida pelo sistema. Aqui só existe ativar/pausar e as métricas: nada de
 * criar automação, escolher gatilho ou montar etapa. Os envios em si são testados nos testes de integração (os jobs ficam desligados no e2e).
 */

const ADMIN = { email: 'gestora@e2e.teste', password: 'senha-e2e-123' };
/** Mesmo valor em tests/e2e/server.ts. */
const WEBHOOK_TOKEN = 'token-do-webhook-e2e';
const SHOTS = resolve('test-results/telas');
mkdirSync(SHOTS, { recursive: true });

async function login(page: Page) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(ADMIN.email);
  await page.getByLabel('Senha').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/chamar$/);
}

/** WAV curtinho e válido (silêncio), para salvar um áudio pela tela. */
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

test('campanha automática: só ativar, pausar e ver as métricas', async ({ page, request }) => {
  // O teste não depende do fluxo principal: garante um número conectado (webhook da Evolution de mentira) e um áudio.
  const connected = await request.post('/webhook/evolution', {
    headers: { 'x-webhook-token': WEBHOOK_TOKEN },
    data: {
      event: 'connection.update',
      instance: 'whatsapp-01',
      data: { state: 'open', wuid: '5511900000001@s.whatsapp.net' },
    },
  });
  expect(connected.ok()).toBe(true);
  await login(page);
  await page.goto('/audios');
  await expect(page.getByRole('heading', { name: 'Áudios', exact: true })).toBeVisible();
  if (!(await page.locator('.wa-lib-item').count())) {
    await page
      .getByRole('button', { name: /Salvar/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: 'Salvar áudio' });
    await dialog.getByLabel('Nome do áudio').fill('Apresentação — campanha');
    await dialog
      .locator('input[type=file]')
      .setInputFiles({ name: 'ola.wav', mimeType: 'audio/wav', buffer: tinyWav() });
    await dialog.getByRole('button', { name: 'Salvar áudio' }).click();
    await expect(page.locator('.wa-lib-item', { hasText: 'Apresentação — campanha' })).toBeVisible();
  }
  await page
    .getByRole('complementary', { name: 'Menu' })
    .getByRole('link', { name: 'Automações', exact: true })
    .click();
  await page.mouse.move(900, 600);
  await expect(page).toHaveURL(/\/automacoes$/);

  const card = page.getByRole('region', { name: 'Campanha automática' });
  await expect(card.getByText('Pronta para ativar')).toBeVisible();
  await expect(
    card.getByText('Seg–Sex · das 10:00 às 16:00 · até 20 contatos por número por dia'),
  ).toBeVisible();
  // Não há nada para montar: nem "Nova automação", nem gatilho, nem etapa.
  await expect(page.getByRole('button', { name: /Nova automação/ })).toHaveCount(0);
  await expect(page.getByText(/gatilho/i)).toHaveCount(0);

  const metrics = page.getByRole('region', { name: 'Métricas' });
  for (const label of ['Para enviar hoje', 'Enviados', 'Sem WhatsApp', 'Responderam', 'Não responderam']) {
    await expect(metrics.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('region', { name: 'Números' }).getByText('whatsapp-01')).toBeVisible();
  await page.screenshot({ path: resolve(SHOTS, '20-automacoes-desativada.png'), fullPage: true });

  await card.getByRole('button', { name: 'Ativar' }).click();
  await expect(page.getByText('Campanha automática ativada.')).toBeVisible();
  await expect(card.getByText('Ativa', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Pausar' })).toBeVisible();
  await page.screenshot({ path: resolve(SHOTS, '21-automacoes-ativa.png'), fullPage: true });

  // Recarregar a página mostra o mesmo estado (fica gravado no servidor).
  await page.reload();
  await expect(card.getByRole('button', { name: 'Pausar' })).toBeVisible();

  await card.getByRole('button', { name: 'Pausar' }).click();
  await expect(page.getByText('Campanha automática pausada.')).toBeVisible();
  await expect(card.getByText('Pausada', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Ativar de novo' })).toBeVisible();

  // Endereços antigos do editor de automações voltam para a campanha automática.
  await page.goto('/automacoes/1');
  await expect(page).toHaveURL(/\/automacoes$/);
  await expect(card).toBeVisible();
});
