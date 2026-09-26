const fs = require('fs');
const p = 'src/web/styles.css';
let s = fs.readFileSync(p, 'utf8');
const a = `.kpi-s {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px 0;
  margin-top: 2px;
  font-size: 13px;
  color: var(--muted);
}
.kpi-s b {
  color: var(--ink);
  font-weight: 600;
  margin-left: 4px;
}`;
if (!s.includes(a)) throw new Error('kpi-s');
s = s.replace(a, `.kpi-s {
  margin-top: 2px;
  font-size: 13px;
  color: var(--muted);
}
.kpi-s b {
  color: var(--ink);
  font-weight: 600;
}`);
fs.writeFileSync(p, s);
console.log('ok');
