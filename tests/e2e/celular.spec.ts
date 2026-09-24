import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/** No celular: a atendente entra, vê a fila e a tela não tem rolagem para o lado. Roda depois do fluxo principal. */
test('fila do atendente no celular', async ({ page, context }) => {
  await context.route(/wa\.me|whatsapp\.com/, (route) => route.fulfill({ status: 200, body: 'simulado' }));
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill('bruno@e2e.teste');
  await page.getByLabel('Senha').fill('senha-do-bruno-1');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/chamar$/);
  await expect(page.locator('li.lead').first()).toBeVisible();
  // Link wa.me: no celular abre direto o aplicativo do WhatsApp.
  const href = await page
    .locator('li.lead')
    .first()
    .getByRole('link', { name: 'Chamar no WhatsApp' })
    .getAttribute('href');
  expect(href).toMatch(/^https:\/\/wa\.me\/55\d{10,11}\?text=/);
  // A barra de atalhos de baixo aparece no celular.
  await expect(page.getByRole('navigation', { name: 'Atalhos' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: resolve('test-results/telas/09-celular.png'), fullPage: false });
  await page.getByRole('button', { name: 'Modo foco' }).click();
  await expect(page.locator('.focus-card')).toBeVisible();
  const overflowFocus = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflowFocus).toBeLessThanOrEqual(0);
  await page.screenshot({ path: resolve('test-results/telas/10-celular-foco.png'), fullPage: false });
});
