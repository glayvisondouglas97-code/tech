import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * Automações no celular (Pixel 7): a lista e o editor não rolam para o lado, os botões das etapas ficam ao
 * alcance do dedo e a janela de etapa cabe na tela. Roda depois dos testes do computador.
 */

const ADMIN = { email: 'gestora@e2e.teste', password: 'senha-e2e-123' };
const SHOTS = resolve('test-results/telas');
mkdirSync(SHOTS, { recursive: true });

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('editor de automações no celular', async ({ page }) => {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(ADMIN.email);
  await page.getByLabel('Senha').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/chamar$/);

  // Uma automação com duas etapas, montada pela API para o teste ir direto ao que importa.
  const csrf = (await (await page.request.get('/api/auth/me')).json()).csrfToken;
  const headers = { 'x-csrf-token': csrf };
  const created = await page.request.post('/api/automations', {
    headers,
    data: { name: 'Follow-up no celular', description: 'Teste de tela pequena', trigger: 'lead_called' },
  });
  const id = (await created.json()).id;
  for (const [delaySeconds, messageText] of [
    [0, 'Olá, {{nome}}! Tudo bem? Aqui é {{atendente}}, falando da {{empresa}}.'],
    [7200, 'Conseguiu verificar nossa mensagem? Qualquer dúvida é só chamar por aqui, sem compromisso.'],
  ] as const) {
    const r = await page.request.post(`/api/automations/${id}/steps`, {
      headers,
      data: {
        actionType: 'send_text',
        delaySeconds,
        messageText,
        conditions: [{ field: 'lead_result', operator: 'is_not', value: 'respondeu' }],
      },
    });
    expect(r.status()).toBe(201);
  }

  // Lista.
  await page.goto('/automacoes');
  await expect(page.getByRole('heading', { name: 'Automações', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /Follow-up no celular/ })).toBeVisible();
  await noSideScroll(page);
  await page.screenshot({ path: resolve(SHOTS, 'a20-celular-lista.png'), fullPage: false });

  // Editor.
  await page.getByRole('link', { name: /Follow-up no celular/ }).click();
  await expect(page.getByRole('heading', { name: 'Follow-up no celular', level: 1 })).toBeVisible();
  const first = page.getByRole('listitem', { name: 'Etapa 1', exact: true });
  await expect(first).toContainText('Imediatamente');
  await noSideScroll(page);
  await page.screenshot({ path: resolve(SHOTS, 'a21-celular-editor.png'), fullPage: true });

  // Os botões de cada etapa cabem na largura da tela e têm tamanho para tocar.
  const width = page.viewportSize()?.width ?? 412;
  for (const name of ['Subir a etapa 2', 'Descer a etapa 1', 'Editar a etapa 1', 'Excluir a etapa 1']) {
    const button = page.getByRole('button', { name });
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    expect(box, name).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0), `${name} cabe na tela`).toBeLessThanOrEqual(width);
    expect(box?.height ?? 0, `${name} tem altura para o dedo`).toBeGreaterThanOrEqual(34);
  }

  // Reordena tocando.
  await page.getByRole('button', { name: 'Descer a etapa 1' }).tap();
  await expect(page.getByRole('listitem', { name: 'Etapa 1', exact: true })).toContainText(
    'Conseguiu verificar',
  );

  // A janela de etapa cabe na tela (folha que sobe de baixo) e o botão de salvar fica à vista.
  await page.getByRole('button', { name: 'Editar a etapa 1' }).tap();
  const dialog = page.getByRole('dialog', { name: 'Editar etapa 1' });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(width);
  await noSideScroll(page);
  await page.waitForTimeout(450); // a folha termina de subir
  await page.screenshot({ path: resolve(SHOTS, 'a22-celular-dialogo-etapa.png'), fullPage: false });
  const save = dialog.getByRole('button', { name: 'Salvar etapa' });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await dialog.getByLabel('Tipo da ação').selectOption({ label: 'Enviar áudio' });
  await expect(dialog.getByLabel('Mensagem', { exact: true })).toHaveCount(0);
  await noSideScroll(page);
  await dialog.getByRole('button', { name: 'Cancelar' }).tap();
  await expect(dialog).toBeHidden();
});
