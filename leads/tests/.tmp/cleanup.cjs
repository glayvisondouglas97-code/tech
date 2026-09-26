const fs = require('fs');
const P = 'src/web/styles.css';
let s = fs.readFileSync(P, 'utf8');
const dead = [
  '.kpi > div',
  '.kpi-ic',
  '.kpi-ok .kpi-ic',
  '.kpi-warn .kpi-ic',
  '.kpi-info .kpi-ic',
  '.kpi-ic svg',
  '.me-card',
  '.me-card:hover,\n.me-card[aria-expanded="true"]',
  '.me-text',
  '.me-name',
  '.me-role',
  '.me-chev',
];
let removed = 0;
for (const sel of dead) {
  for (const indent of ['', '  ']) {
    const head = `\n${indent}${sel} {\n`;
    for (;;) {
      const i = s.indexOf(head);
      if (i < 0) break;
      const end = s.indexOf(`\n${indent}}\n`, i + head.length);
      s = s.slice(0, i) + s.slice(end + indent.length + 2);
      removed++;
    }
  }
}
fs.writeFileSync(P, s);
console.log('regras removidas:', removed);
