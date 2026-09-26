import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { clearTodayUsage, runQuotaBackfill, seedTodayUsage } from './db';

/**
 * Backfill da cota do dia e limite na tela (etapa final antes do primeiro teste real). Roda depois do fluxo principal, em que a
 * atendente Ana já fez UM contato pelo botão Chamar no whatsapp-01: o sistema contou 1/20 ao vivo. Aqui a cota de hoje é apagada
 * ("antes da migração"), o backfill (a migração 0015, a mesma do sistema) é executado e a tela de Números tem que mostrar de
 * novo o mesmo 1/20, e não 0/20. Depois: 12/20 (7 manuais + 5 automáticos) e o Chamar recusado em 20/20.
 */

const ADMIN = { email: 'gestora@e2e.teste', password: 'senha-e2e-123' };
const ANA = { email: 'ana@e2e.teste', password: 'senha-da-ana-1' };
const NUMBER = 'whatsapp-01';
const SHOTS = resolve('test-results/telas');
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true });
}

interface Usage {
  manual: number;
  automatic: number;
  uncertain: number;
  total: number;
  limit: number;
  remaining: number;
  limitReached: boolean;
}
interface InstanceRow {
  id: number;
  name: string;
  usage: Usage;
}

test.describe.configure({ mode: 'serial' });

let admin: Page;
let baseline: Usage;
let id = 0;

const usageNow = async (): Promise<Usage> => {
  const rows = (await (await admin.request.get('/api/instances')).json()) as InstanceRow[];
  return (rows.find((r) => r.name === NUMBER) as InstanceRow).usage;
};
const totalText = (usage: Pick<Usage, 'total' | 'limit'>) => `${usage.total}/${usage.limit} contatos hoje`;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  admin = await context.newPage();
  await admin.goto('/entrar');
  await admin.getByLabel('E-mail').fill(ADMIN.email);
  await admin.getByLabel('Senha').fill(ADMIN.password);
  await admin.getByRole('button', { name: 'Entrar' }).click();
  await expect(admin).toHaveURL(/\/chamar$/);
  const rows = (await (await admin.request.get('/api/instances')).json()) as InstanceRow[];
  id = (rows.find((r) => r.name === NUMBER) as InstanceRow).id;
  baseline = await usageNow();
});

test.afterAll(async () => {
  // Deixa a cota de hoje como o sistema a contou (o que os outros testes esperam).
  await clearTodayUsage('whatsapp-01');
  await runQuotaBackfill();
});

test('o contato feito antes da cota volta depois do backfill: Números mostra o mesmo 1/20, não 0/20', async () => {
  expect(baseline).toMatchObject({ manual: 1, automatic: 0, total: 1, limit: 20 }); // o Chamar do fluxo principal
  await admin.goto('/numeros');
  await expect(admin.getByTestId(`numero-uso-total-${id}`)).toHaveText(totalText(baseline));

  // "Antes da migração": a cota de hoje não existe.
  await clearTodayUsage('whatsapp-01');
  await admin.reload();
  await expect(admin.getByTestId(`numero-uso-total-${id}`)).toHaveText('0/20 contatos hoje');
  await shot(admin, 'c30-cota-antes-do-backfill');

  // A migração roda: o dia é reconstruído a partir das mensagens (manual e automático separados).
  await runQuotaBackfill();
  await admin.reload();
  await expect(admin.getByTestId(`numero-uso-total-${id}`)).toHaveText(totalText(baseline));
  expect(await usageNow()).toMatchObject({ manual: 1, automatic: 0, uncertain: 0, total: 1, remaining: 19 });
  await shot(admin, 'c31-cota-depois-do-backfill');
  // Rodar a migração de novo não soma nada.
  await runQuotaBackfill();
  expect(await usageNow()).toMatchObject({ manual: 1, automatic: 0, total: 1 });
});

test('12/20 (7 manuais + 5 automáticos): Números mostra o uso do dia e o que resta', async () => {
  await seedTodayUsage(NUMBER, { manual: 7, automatic: 5 });
  await admin.goto('/numeros');
  await expect(admin.getByTestId(`numero-uso-total-${id}`)).toHaveText('12/20 contatos hoje');
  await expect(admin.getByTestId(`numero-uso-${id}`).getByText(/7 manuais · 5 automáticos/)).toBeVisible();
  expect(await usageNow()).toMatchObject({
    manual: 7,
    automatic: 5,
    total: 12,
    remaining: 8,
    limitReached: false,
  });
  await shot(admin, 'c32-numeros-12-de-20');
});

test('Chamar com o número em 20/20 não inicia primeiro contato: a tela avisa e nada é enviado', async ({
  browser,
}) => {
  await seedTodayUsage(NUMBER, { manual: 13, automatic: 7 });
  const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await context.newPage();
  try {
    await page.goto('/entrar');
    await page.getByLabel('E-mail').fill(ANA.email);
    await page.getByLabel('Senha').fill(ANA.password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page).toHaveURL(/\/chamar$/);
    await page.locator('li.lead').first().getByRole('button', { name: 'Chamar no WhatsApp' }).click();
    const dialog = page.getByRole('dialog', { name: 'Chamar pelo WhatsApp' });
    const option = dialog.getByRole('button', { name: /whatsapp-01/ });
    await expect(option).toContainText('20/20 hoje');
    await expect(dialog.getByText('Limite diário atingido')).toBeVisible();
    await option.click();
    await expect(dialog.getByRole('alert')).toContainText(
      'Este número já atingiu o limite de 20 contatos hoje.',
    );
    await expect(page).toHaveURL(/\/chamar$/); // não abriu conversa nenhuma
    await shot(page, 'c33-chamar-numero-cheio');
  } finally {
    await context.close();
  }
  expect(await usageNow()).toMatchObject({
    manual: 13,
    automatic: 7,
    uncertain: 0,
    total: 20,
    limitReached: true,
  });
});
