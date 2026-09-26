const fs = require('fs');
const p = 'tests/e2e/fluxo-principal.spec.ts';
let s = fs.readFileSync(p, 'utf8');
const a = "const nav = (page: Page, label: string) =>\n  page.getByRole('navigation', { name: 'Seções' }).getByRole('link', { name: label }).click();";
if (!s.includes(a)) throw new Error('nav helper');
s = s.replace(
  a,
  "/** Clica no menu lateral e tira o mouse de cima dele (o menu abre ao passar o mouse e cobriria a tela). */\nasync function nav(page: Page, label: string) {\n  await page.getByRole('navigation', { name: 'Seções' }).getByRole('link', { name: label }).click();\n  await page.mouse.move(900, 600);\n}",
);
fs.writeFileSync(p, s);
console.log('ok');
