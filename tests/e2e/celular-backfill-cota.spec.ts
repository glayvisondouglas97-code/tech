import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { clearTodayUsage, runQuotaBackfill, seedTodayUsage } from './db';

/**
 * A cota diária no celular (Pixel 7): Números mostra o uso do dia (12/20 e 20/20) e o "Chamar" com o número cheio avisa,
 * sem rolar para o lado. Roda depois dos testes do computador.
 */

const ADMIN = { email: 'gestora@e2e.teste', password: 'senha-e2e-123' };
const ANA = { email: 'ana@e2e.teste', password: 'senha-da-ana-1' };
const SHOTS = resolve('test-results/telas');
mkdirSync(SHOTS, { recursive: true });

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function login(page: Page, user: { email: string; password: string }) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(user.email);
  await page.getByLabel('Senha').fill(user.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/chamar$/);
}

test.afterAll(async () => {
  await clearTodayUsage('whatsapp-01');
  await runQuotaBackfill();
});

test('cota no celular: Números mostra 12/20 e o Chamar recusa o número em 20/20', async ({ page }) => {
  await login(page, ADMIN);
  const rows = (await (await page.request.get('/api/instances')).json()) as { id: number; name: string }[];
  const id = (rows.find((r) => r.name === 'whatsapp-01') as { id: number }).id;

  await seedTodayUsage('whatsapp-01', { manual: 7, automatic: 5 });
  await page.goto('/numeros');
  await expect(page.getByTestId(`numero-uso-total-${id}`)).toHaveText('12/20 contatos hoje');
  await expect(page.getByTestId(`numero-uso-${id}`).getByText(/7 manuais · 5 automáticos/)).toBeVisible();
  await noSideScroll(page);
  await page.screenshot({ path: resolve(SHOTS, 'c34-celular-numeros-12-de-20.png'), fullPage: true });

  await seedTodayUsage('whatsapp-01', { manual: 13, automatic: 7 });
  await page.context().clearCookies(); // sai da gestão e entra como a atendente
  await login(page, ANA);
  await page.locator('li.lead').first().getByRole('button', { name: 'Chamar no WhatsApp' }).tap();
  const dialog = page.getByRole('dialog', { name: 'Chamar pelo WhatsApp' });
  const option = dialog.getByRole('button', { name: /whatsapp-01/ });
  await expect(option).toContainText('20/20 hoje');
  await option.tap();
  await expect(dialog.getByRole('alert')).toContainText(
    'Este número já atingiu o limite de 20 contatos hoje.',
  );
  await expect(page).toHaveURL(/\/chamar$/);
  await noSideScroll(page);
  await page.screenshot({ path: resolve(SHOTS, 'c35-celular-chamar-numero-cheio.png'), fullPage: false });
});
