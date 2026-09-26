const fs = require('fs');
const p = 'tests/e2e/fluxo-principal.spec.ts';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error(`não achei ${a.slice(0, 60)}`);
  s = s.replace(a, b);
};
rep(
  "  const row = admin.getByRole('row', { name: new RegExp(ana.name) });\n  await expect(row).toBeVisible();\n  await expect(row.getByRole('cell').nth(1)).toHaveText('1');\n  await shot(admin, '06-painel');",
  "  const card = admin.locator('.acard', { hasText: ana.name });\n  await expect(card).toBeVisible();\n  await expect(card.locator('.acard-v')).toHaveText('1');\n  await shot(admin, '06-painel');\n  // Menu lateral: abre ao passar o mouse e mostra o nome de todas as seções.\n  await admin.locator('aside.side').hover();\n  await expect(admin.locator('aside.side .side-text', { hasText: 'Auditoria' })).toBeVisible();\n  await admin.waitForTimeout(400);\n  await admin.screenshot({ path: resolve(SHOTS, '06b-menu-aberto.png') });\n  await admin.mouse.move(900, 500);",
);
fs.writeFileSync(p, s);
console.log('ok');
