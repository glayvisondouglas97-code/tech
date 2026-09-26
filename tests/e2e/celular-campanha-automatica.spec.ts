import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/** No celular: a aba Automações (campanha automática) e a de Áudios cabem na tela, sem rolagem para o lado. */
test('campanha automática e áudios no celular', async ({ page }) => {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill('gestora@e2e.teste');
  await page.getByLabel('Senha').fill('senha-e2e-123');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/chamar$/);

  await page.goto('/automacoes');
  const card = page.getByRole('region', { name: 'Campanha automática' });
  await expect(card).toBeVisible();
  const toggle = card.getByRole('button', { name: /Ativar|Pausar/ });
  await expect(toggle).toBeVisible();
  // O botão ocupa a largura do cartão no celular (fácil de tocar).
  const [buttonBox, cardBox] = [await toggle.boundingBox(), await card.boundingBox()];
  expect((buttonBox?.width ?? 0) / (cardBox?.width ?? 1)).toBeGreaterThan(0.7);
  await expect(
    page.getByRole('region', { name: 'Métricas' }).getByText('Enviados', { exact: true }),
  ).toBeVisible();
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: resolve('test-results/telas/22-celular-automacoes.png'), fullPage: false });

  await page.goto('/audios');
  await expect(page.getByRole('heading', { name: 'Áudios', exact: true })).toBeVisible();
  overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page
    .getByRole('button', { name: /Salvar/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Salvar áudio' });
  // Os dois jeitos de salvar ficam um embaixo do outro, com o texto inteiro dentro do botão.
  const record = await dialog.getByRole('button', { name: 'Gravar pelo microfone' }).boundingBox();
  const file = await dialog.getByText('Escolher arquivo').boundingBox();
  expect((file?.y ?? 0) > (record?.y ?? 0)).toBe(true);
  await page.screenshot({ path: resolve('test-results/telas/23-celular-audios.png'), fullPage: false });
});
