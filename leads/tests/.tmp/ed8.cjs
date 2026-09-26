const fs = require('fs');
const ed = (p, a, b) => {
  let s = fs.readFileSync(p, 'utf8');
  if (!s.includes(a)) throw new Error(`${p}: não achei ${a.slice(0, 60)}`);
  fs.writeFileSync(p, s.replace(a, b));
};
ed(
  'src/web/components/Shell.tsx',
  "export function useTopbarCenter(node: ReactNode, deps: unknown[]) {\n  const set = useContext(TopbarSlot);\n  // biome-ignore lint/correctness/useExhaustiveDependencies: quem chama informa as dependências do conteúdo\n  useEffect(() => {\n    set(node);\n    return () => set(null);\n  }, deps);\n}",
  "export function useTopbarCenter(node: ReactNode, key: unknown) {\n  const set = useContext(TopbarSlot);\n  // biome-ignore lint/correctness/useExhaustiveDependencies: o conteúdo só muda quando a chave muda\n  useEffect(() => {\n    set(node);\n    return () => set(null);\n  }, [key, set]);\n}",
);
ed('src/web/pages/QueuePage.tsx', '    </div>,\n    [focus],\n  );', '    </div>,\n    focus,\n  );');
console.log('ok');
