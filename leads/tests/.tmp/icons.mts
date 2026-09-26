import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const svg = readFileSync('src/web/public/favicon.svg', 'utf8');
const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const browser = await chromium.launch();
const page = await browser.newPage();
// Ícone normal: o próprio desenho com cantos arredondados. Maskable/apple: fundo cheio com margem de segurança.
const variants: [string, number, 'plain' | 'full'][] = [
  ['icon-192.png', 192, 'plain'],
  ['icon-512.png', 512, 'plain'],
  ['icon-maskable-512.png', 512, 'full'],
  ['apple-touch-icon.png', 180, 'full'],
];
for (const [name, size, kind] of variants) {
  const body =
    kind === 'plain'
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 28 28">${inner}</svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-7 -7 42 42"><rect x="-7" y="-7" width="42" height="42" fill="#4F46E5"/>${inner}</svg>`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${body}</body></html>`);
  await page.locator('svg').screenshot({ path: `src/web/public/icons/${name}`, omitBackground: true });
  console.log('ok', name);
}
await browser.close();
