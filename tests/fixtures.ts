import * as XLSX from 'xlsx';

export interface FixtureSummary {
  rows: number;
  valid: number;
  duplicatesInFile: number;
  invalid: number;
}

/**
 * Planilha de 1.000 linhas para os critérios de aceite:
 * 900 telefones únicos válidos (450 empresas, 2 sócios cada), 60 repetidos dentro do arquivo e 40 inválidos (sem telefone,
 * curtos demais, texto, CPF). Telefones no formato celular de Curitiba, só para teste.
 */
export function acceptanceRows(): { rows: unknown[][]; summary: FixtureSummary } {
  const header = ['Empresa', 'Sócio', 'Celular', 'Cidade', 'Interesse'];
  const data: unknown[][] = [];
  const formats = [
    (n: string) => `(41) 9${n.slice(0, 4)}-${n.slice(4)}`,
    (n: string) => `419${n}`,
    (n: string) => Number(`55419${n}`),
    (n: string) => `+55 41 9${n.slice(0, 4)} ${n.slice(4)}`,
  ];
  for (let i = 0; i < 900; i++) {
    const n = String(70_000_000 + i).slice(-8);
    data.push([
      `Empresa ${Math.floor(i / 2) + 1} Ltda`,
      `Pessoa ${i + 1}`,
      (formats[i % formats.length] as (n: string) => unknown)(n),
      'Curitiba',
      'Plano',
    ]);
  }
  for (let i = 0; i < 60; i++) {
    const n = String(70_000_000 + i * 7).slice(-8);
    data.push([
      `Repetida ${i + 1} ME`,
      `Sócio ${i + 1}`,
      `41 9${n.slice(0, 4)}-${n.slice(4)}`,
      'Curitiba',
      'Plano',
    ]);
  }
  const bad = ['', '123', 'não tem', '123.456.789-09', '0800 123 4567', '(00) 91234-5678', '99', '41 1234'];
  for (let i = 0; i < 40; i++)
    data.push([`Inválida ${i + 1} Ltda`, `Sócio ${i + 1}`, bad[i % bad.length], 'Curitiba', '']);
  // embaralha de forma determinística, mantendo cada repetida depois da original quando possível
  const shuffled = data
    .map((r, i) => ({ r, k: (i * 7919) % 1009 }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.r);
  return {
    rows: [header, ...shuffled],
    summary: { rows: 1000, valid: 900, duplicatesInFile: 60, invalid: 40 },
  };
}

export function toXlsx(rows: unknown[][], sheet = 'Leads'): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** Corpo multipart/form-data com um arquivo, para app.inject. */
export function multipart(fileName: string, data: Buffer, contentType = 'application/octet-stream') {
  const boundary = `----teste${Date.now().toString(16)}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
