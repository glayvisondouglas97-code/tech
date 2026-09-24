/**
 * Gera os ícones PNG do aplicativo (PWA) a partir de src/web/public/favicon.svg.
 * Só precisa rodar de novo se o logo mudar:  npx tsx scripts/gerar-icones.ts
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const svg = readFileSync(resolve('src/web/public/favicon.svg'), 'utf8');
const out = resolve('src/web/public/icons');
mkdirSync(out, { recursive: true });

const icons: { file: string; size: number; maskable?: boolean }[] = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180, maskable: true },
  // "maskable": o sistema recorta em círculo/gota; o desenho fica dentro da zona segura (80%).
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const icon of icons) {
  const inner = icon.maskable ? Math.round(icon.size * 0.72) : icon.size;
  await page.setViewportSize({ width: icon.size, height: icon.size });
  await page.setContent(
    `<html><body style="margin:0;display:grid;place-items:center;width:${icon.size}px;height:${icon.size}px;background:${icon.maskable ? '#2E44C9' : 'transparent'}">
      <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg style="width:100%;height:100%" `)}</div>
    </body></html>`,
  );
  await page.screenshot({ path: resolve(out, icon.file), omitBackground: !icon.maskable });
  console.log('gerado', icon.file);
}
await browser.close();
