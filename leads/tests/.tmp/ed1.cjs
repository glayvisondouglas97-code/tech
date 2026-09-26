const fs = require('fs');
const ed = (p, pairs) => {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(`${p}: não achei ${a.slice(0, 60)}`);
    s = s.replace(a, b);
  }
  fs.writeFileSync(p, s);
};
ed('src/web/main.tsx', [
  [
    "import '@fontsource-variable/inter';\n",
    "import '@fontsource/poppins/400.css';\nimport '@fontsource/poppins/500.css';\nimport '@fontsource/poppins/600.css';\nimport '@fontsource/poppins/700.css';\n",
  ],
]);
ed('src/web/components/Icons.tsx', [
  [
    'export const IconChevron = ',
    `export const IconBell = icon(['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0']);
export const IconGrid = icon([
  'M4 4h6v6H4z',
  'M14 4h6v6h-6z',
  'M4 14h6v6H4z',
  'M14 14h6v6h-6z',
]);
export const IconUpload = icon(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5', 'M12 3v12']);
export const IconChevron = `,
  ],
]);
console.log('ok');
