// Capturas das telas para revisão visual (não faz parte da suíte). Uso: npx tsx tests/.tmp/shots.mts [filtro]
import { mkdirSync } from 'node:fs';
import { chromium, devices } from '@playwright/test';
import { DEMO_PASSWORD } from '../../src/server/scripts/seed';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const OUT = 'tests/.tmp/shots';
const only = process.argv[2];
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const views = {
  desk: { viewport: { width: 1440, height: 900 } },
  cel: { ...devices['Pixel 7'] },
};

async function session(view: keyof typeof views, email: string, dark = false) {
  const ctx = await browser.newContext({
    ...views[view],
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    colorScheme: dark ? 'dark' : 'light',
  });
  await ctx.route(/wa\.me|whatsapp\.com/, (r) => r.fulfill({ status: 200, body: 'simulado' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`${BASE}/entrar`);
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(/\/chamar$/);
  await page.waitForTimeout(600);
  return { ctx, page };
}

async function shot(page: import('@playwright/test').Page, name: string, full = true) {
  if (only && !name.includes(only)) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log('ok', name);
}

// Entrar (sem sessão)
for (const v of ['desk', 'cel'] as const) {
  const ctx = await browser.newContext({ ...views[v], locale: 'pt-BR' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/entrar`);
  await shot(page, `${v}-00-entrar`, false);
  await ctx.close();
}

const pages = ['chamar', 'chamados', 'painel', 'leads', 'listas', 'equipe', 'auditoria', 'configuracoes', 'conta'];
{
  const { ctx, page } = await session('desk', 'dono@exemplo.com.br');
  for (const [i, p] of pages.entries()) {
    await page.goto(`${BASE}/${p}`);
    await shot(page, `desk-${String(i + 1).padStart(2, '0')}-${p}`);
  }
  await ctx.close();
}
{
  const { ctx, page } = await session('desk', 'ana@exemplo.com.br');
  await shot(page, 'desk-20-ana-chamar');
  await page.locator('li.lead .icon-btn').first().click();
  await shot(page, 'desk-21-ana-menu', false);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Modo foco' }).click();
  await shot(page, 'desk-22-ana-foco');
  await ctx.close();
}
{
  const { ctx, page } = await session('desk', 'dono@exemplo.com.br', true);
  for (const p of ['chamar', 'painel', 'auditoria']) {
    await page.goto(`${BASE}/${p}`);
    await shot(page, `desk-30-dark-${p}`);
  }
  await ctx.close();
}
{
  const { ctx, page } = await session('cel', 'ana@exemplo.com.br');
  await shot(page, 'cel-01-chamar', false);
  await shot(page, 'cel-02-chamar-full');
  if (!only || 'cel-06-card'.includes(only)) await page.locator('li.lead').nth(1).screenshot({ path: `${OUT}/cel-06-card.png` });
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await shot(page, 'cel-03-menu', false);
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/chamados`);
  await shot(page, 'cel-04-chamados', false);
  await page.goto(`${BASE}/painel`);
  await shot(page, 'cel-05-painel', false);
  await ctx.close();
}
{
  const { ctx, page } = await session('cel', 'dono@exemplo.com.br', true);
  await shot(page, 'cel-10-dark-chamar', false);
  await page.goto(`${BASE}/listas`);
  await shot(page, 'cel-11-dark-listas', false);
  await ctx.close();
}
await browser.close();
