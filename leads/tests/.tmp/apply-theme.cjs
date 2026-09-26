const fs = require('fs');
const P = 'src/web/styles.css';
let s = fs.readFileSync(P, 'utf8');
const frag = (f) => fs.readFileSync(`tests/.tmp/${f}`, 'utf8');

function between(startMark, endMark, replacement) {
  const a = s.indexOf(startMark);
  const b = s.indexOf(endMark);
  if (a < 0 || b < 0 || b < a) throw new Error(`marcas não encontradas: ${startMark} / ${endMark}`);
  s = s.slice(0, a) + replacement + s.slice(b);
}

/** Troca (ou acrescenta) uma propriedade dentro da primeira regra de nível raiz com esse seletor. */
function setProp(selector, prop, value, { all = false } = {}) {
  const head = `\n${selector} {\n`;
  let from = 0;
  let found = false;
  for (;;) {
    const i = s.indexOf(head, from);
    if (i < 0) break;
    const start = i + head.length;
    const end = s.indexOf('\n}', start);
    let body = s.slice(start, end);
    const re = new RegExp(`^  ${prop.replace(/[-]/g, '\\-')}: [^;]*;$`, 'm');
    body = re.test(body) ? body.replace(re, `  ${prop}: ${value};`) : `${body}\n  ${prop}: ${value};`;
    s = s.slice(0, start) + body + s.slice(end);
    found = true;
    if (!all) break;
    from = start + body.length;
  }
  if (!found) throw new Error(`regra não encontrada: ${selector}`);
}

function rep(a, b) {
  if (!s.includes(a)) throw new Error(`não achei: ${a.slice(0, 70)}`);
  s = s.split(a).join(b);
}

// 1. Tokens e 2. estrutura
between('/*\n * Sistema de design', '/* ---------- base ---------- */', frag('theme-tokens.css'));
between(
  '/* ---------- estrutura: menu lateral, barra do celular ---------- */',
  '/* ---------- cabeçalhos, painéis, avisos ---------- */',
  frag('theme-shell.css'),
);

// 3. Tipografia
setProp('body', 'font', '14px / 1.55 var(--f)');
setProp('body', 'letter-spacing', '0');
rep('  font-feature-settings: "cv11";\n', '');
setProp('h1', 'font-size', '30px');
setProp('h1', 'font-weight', '600');
setProp('h2', 'font-size', '17px');
setProp('h2', 'font-weight', '600');
setProp('h3', 'font-weight', '600');
setProp('.eyebrow', 'font-weight', '500');
setProp('.eyebrow', 'letter-spacing', '0.08em');
setProp('.eyebrow', 'text-transform', 'uppercase');
rep('  h1 {\n    font-size: 21px;\n  }', '  h1 {\n    font-size: 24px;\n  }');

// 4. Formas: cartões grandes, botões e selos em pílula, campos arredondados
setProp('.btn', 'border-radius', '999px');
setProp('.btn', 'font-weight', '500');
setProp('.btn', 'height', '42px');
setProp('.btn', 'padding', '0 18px');
setProp('.btn-sm', 'border-radius', '999px');
setProp('.btn-lg', 'border-radius', '999px');
setProp('.icon-btn', 'border-radius', '50%');
setProp('.tag', 'border-radius', '999px');
setProp('.tag', 'border', '0');
setProp('.tag', 'background', 'var(--sunk)');
setProp('.tag', 'padding', '2px 10px');
setProp('.lead-ava', 'border-radius', '50%');
setProp('.lead-ava', 'background', 'hsl(var(--h, 0) var(--av-s) var(--av-l))');
setProp('.lead-ava', 'color', 'hsl(var(--h, 0) 55% var(--av-ink-l))');
setProp('.lead-ava', 'font-weight', '600');
setProp('.lead-ava.cb', 'background', 'var(--warn-soft)');
setProp('.lead-ava.cb', 'color', 'var(--warn)');
rep('  border-top-left-radius: 13px;\n  border-top-right-radius: 13px;', '  border-top-left-radius: calc(var(--r-card) - 1px);\n  border-top-right-radius: calc(var(--r-card) - 1px);');
rep('  border-bottom-left-radius: 13px;\n  border-bottom-right-radius: 13px;', '  border-bottom-left-radius: calc(var(--r-card) - 1px);\n  border-bottom-right-radius: calc(var(--r-card) - 1px);');
setProp('.subtab,\n.seg button', 'border-radius', '999px');
setProp('.subtabs,\n.seg', 'border-radius', '999px');
setProp('.subtabs,\n.seg', 'padding', '4px');
setProp('dialog.dlg', 'border-radius', '28px');
setProp('dialog.drawer', 'border-radius', '28px 0 0 28px');
setProp('.focus-card', 'border-radius', 'var(--r-card)');
setProp('.menu', 'border-radius', 'var(--r-md)');
setProp('.menu', 'padding', '8px');
setProp('.toast', 'border-radius', '999px');
setProp('.toast', 'padding', '10px 10px 10px 20px');
setProp('.toast button', 'border-radius', '999px');
setProp('.empty-ic', 'border-radius', '50%');
setProp('.empty-ic', 'background', 'var(--sunk)');
setProp('.empty-ic', 'color', 'var(--ink)');
setProp('.panel', 'padding', '24px 26px');
setProp('.panel', 'box-shadow', 'var(--shadow-xs)');
setProp('.tbl-wrap', 'border', '0');
setProp('.tbl-wrap', 'border-radius', '0');
setProp('.tbl th', 'background', 'transparent');
setProp('.tbl th', 'font-size', '11.5px');
setProp('.tbl th', 'font-weight', '500');
setProp('.tbl th', 'letter-spacing', '0.08em');
setProp('.tbl th', 'text-transform', 'uppercase');
setProp('.tbl th', 'padding', '10px 14px 12px');
setProp('.skip', 'border-radius', '999px');
// raios de cartões e caixas (todos de uma vez)
rep('border-radius: 14px;', 'border-radius: var(--r-card);');
rep('border-radius: 12px;', 'border-radius: var(--r-md);');
rep('border-radius: 10px;', 'border-radius: var(--r-sm);');
setProp('.input,\n.select,\ntextarea.input', 'border-radius', 'var(--r-in)');
setProp('.input,\n.select,\ntextarea.input', 'height', '44px');
setProp('.input,\n.select,\ntextarea.input', 'box-shadow', 'none');
setProp('.input,\n.select,\ntextarea.input', 'border', '1px solid var(--line-strong)');

// 5. Tela de entrar em preto
rep('  color: #c7d2fe;\n  background-color: #1e1b4b;', '  color: #c9c9c9;\n  background-color: #0f0f10;');
rep(
  '    radial-gradient(900px 520px at -10% -10%, rgba(99, 102, 241, 0.6), transparent 60%),\n    radial-gradient(700px 480px at 110% 110%, rgba(34, 197, 94, 0.28), transparent 60%);',
  '    radial-gradient(900px 520px at -10% -10%, rgba(255, 255, 255, 0.12), transparent 60%),\n    radial-gradient(700px 480px at 110% 110%, rgba(92, 191, 61, 0.22), transparent 60%);',
);
rep('  --accent: #a5b4fc;\n  --accent-ink: #1e1b4b;', '  --accent: #ffffff;\n  --accent-ink: #111111;');

// 6. Componentes novos antes das animações
between('/* ---------- animações ---------- */', '/* ---------- animações ---------- */', `${frag('theme-comp.css')}`);

fs.writeFileSync(P, s);
console.log('tema aplicado,', s.split('\n').length, 'linhas');
