import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/** No celular: a atendente entra, vê a fila e a tela não tem rolagem para o lado. Roda depois do fluxo principal. */
test('fila do atendente no celular', async ({ page }) => {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill('bruno@e2e.teste');
  await page.getByLabel('Senha').fill('senha-do-bruno-1');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/chamar$/);
  await expect(page.locator('li.lead').first()).toBeVisible();
  // "Chamar" abre a escolha do número (a conversa fica dentro do sistema, sem wa.me).
  await page.locator('li.lead').first().getByRole('button', { name: 'Chamar no WhatsApp' }).click();
  await expect(page.getByRole('dialog', { name: 'Chamar pelo WhatsApp' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
  // A barra de atalhos de baixo aparece no celular e fica fixa: a página não rola, só o conteúdo.
  const tabbar = page.getByRole('navigation', { name: 'Atalhos' });
  await expect(tabbar).toBeVisible();
  const before = await tabbar.boundingBox();
  await page.locator('.app-main').evaluate((el) => el.scrollBy(0, 600));
  await page.mouse.wheel(0, 600);
  expect(await page.locator('.app-main').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);
  expect(await tabbar.boundingBox()).toEqual(before);
  await page.locator('.app-main').evaluate((el) => el.scrollTo(0, 0));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: resolve('test-results/telas/09-celular.png'), fullPage: false });
  await page.getByRole('button', { name: 'Modo foco' }).click();
  await expect(page.locator('.focus-card')).toBeVisible();
  const overflowFocus = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflowFocus).toBeLessThanOrEqual(0);
  await page.screenshot({ path: resolve('test-results/telas/10-celular-foco.png'), fullPage: false });
});
