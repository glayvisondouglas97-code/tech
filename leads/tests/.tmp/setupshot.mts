import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, locale: 'pt-BR' });
await page.goto('http://localhost:5173/');
await page.waitForURL(/primeiro-acesso|entrar/);
await page.waitForTimeout(600);
await page.screenshot({ path: 'tests/.tmp/shots/setup.png' });
console.log(page.url());
await browser.close();
