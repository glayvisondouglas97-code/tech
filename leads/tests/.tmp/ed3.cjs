const fs = require('fs');
const p = 'src/web/pages/QueuePage.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error(`não achei ${a.slice(0, 60)}`);
  s = s.replace(a, b);
};
rep(
  "  useShortcuts({ '/': () => searchRef.current?.focus(), f: () => setFocus(!focus) }, !focus);",
  `  useShortcuts({ '/': () => searchRef.current?.focus(), f: () => setFocus(!focus) }, !focus);

  // Seletor Lista / Modo foco no meio da barra de cima (computador).
  useTopbarCenter(
    <div className="seg-float" role="radiogroup" aria-label="Como ver a fila">
      <button type="button" role="radio" aria-checked={!focus} title="Lista" onClick={() => setFocus(false)}>
        <IconGrid />
        <span className="vh">Lista</span>
      </button>
      <button type="button" role="radio" aria-checked={focus} title="Modo foco" onClick={() => setFocus(true)}>
        <IconFocus size={20} />
        <span className="vh">Modo foco</span>
      </button>
    </div>,
    [focus],
  );`,
);
rep(
  "            className={`btn btn-sm ${focus ? 'btn-primary' : 'btn-line'}`}\n            aria-pressed={focus}",
  "            className={`btn btn-sm hide-lg ${focus ? 'btn-primary' : 'btn-line'}`}\n            aria-pressed={focus}",
);
rep("import { useQueueStats } from '../components/Shell';", "import { useQueueStats, useTopbarCenter } from '../components/Shell';");
rep('  IconFocus,\n', '  IconFocus,\n  IconGrid,\n');
for (const unused of ['  IconChart,\n', '  IconCheckCircle,\n', '  IconInbox,\n', '  IconLayers,\n']) rep(unused, '');
fs.writeFileSync(p, s);
console.log('ok');
