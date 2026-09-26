const fs = require('fs');
const ed = (p, pairs) => {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(`${p}: não achei ${a.slice(0, 60)}`);
    s = s.replace(a, b);
  }
  fs.writeFileSync(p, s);
};
ed('src/web/components/ui.tsx', [['function hue(name: string): number {', 'export function hue(name: string): number {']]);
ed('src/web/pages/QueuePage.tsx', [
  [
    '      <span className="lead-ava" aria-hidden="true">\n        {companyInitials(leadLabel(lead))}',
    '      <span\n        className="lead-ava"\n        aria-hidden="true"\n        style={{ \'--h\': hue(leadLabel(lead)) } as React.CSSProperties}\n      >\n        {companyInitials(leadLabel(lead))}',
  ],
  ["import { Confirm, copyText, Empty, Menu, Skeleton } from '../components/ui';", "import { Confirm, copyText, Empty, hue, Menu, Skeleton } from '../components/ui';"],
]);
console.log('ok');
