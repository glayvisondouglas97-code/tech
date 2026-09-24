import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { finalizeRows, prepareRows } from '../../src/server/modules/imports/analyze';
import { readTable } from '../../src/server/modules/imports/read-file';

function xlsx(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('leitura de Excel', () => {
  it('lê telefones gravados como número, datas e várias abas', () => {
    // Datas do Excel são "de parede" (sem fuso): meia-noite local.
    const date = new Date(2024, 0, 15);
    const buf = xlsx({
      Leads: [
        ['Nome', 'Telefone', 'Cadastro', 'Valor'],
        ['Maria', 5541998765432, date, 1500.5],
        ['João', '(11) 91234-5678', null, 10],
      ],
      Outra: [['x'], ['y']],
    });
    const t = readTable(buf, 'lista.xlsx');
    expect(t.sheets).toEqual(['Leads', 'Outra']);
    expect(t.sheet).toBe('Leads');
    expect(t.rows[1]?.cells[1]).toBe('5541998765432');
    expect(t.rows[1]?.cells[2]).toBe('15/01/2024');
    expect(t.rows[1]?.cells[3]).toBe('1500,5');
    expect(t.rows[2]?.cells).toEqual(['João', '(11) 91234-5678', '', '10']);
    expect(readTable(buf, 'lista.xlsx', 'Outra').rows.map((r) => r.cells[0])).toEqual(['x', 'y']);
  });

  it('lê .xls (formato antigo)', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Nome', 'Tel'],
        ['Maria', '41 99876-5432'],
      ]),
      'P1',
    );
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }) as Buffer;
    expect(readTable(buf, 'antigo.xls').rows[1]?.cells).toEqual(['Maria', '41 99876-5432']);
  });

  it('recusa arquivo que não é planilha', () => {
    expect(() => readTable(Buffer.from('x'), 'foto.png')).toThrow(/Formato não aceito/);
  });
});

describe('análise da importação', () => {
  const table = readTable(
    Buffer.from(
      [
        'Nome;Telefone;Cidade;Vazia',
        'Maria Silva;(41) 99876-5432;Curitiba;',
        'João;11 91234-5678;São Paulo;',
        'Maria de novo;41998765432;Curitiba;',
        'Sem DDD;99876-1111;;',
        'Inválido;123;;',
        'Sem telefone;;;',
        'Bloqueado;21 99999-0000;Rio;',
        'Na base;31 98888-7777;BH;',
      ].join('\n'),
    ),
    'x.csv',
  );
  const mapping = { hasHeader: true, companyColumn: -1, nameColumn: 0, phoneColumn: 1, defaultDdd: null };

  it('normaliza, guarda colunas extras e ignora colunas vazias', async () => {
    const p = await prepareRows(table, mapping);
    expect(p.extraColumns.map((c) => c.key)).toEqual(['Cidade']);
    expect(p.rows[0]).toMatchObject({ rowNumber: 2, name: 'Maria Silva', extra: { Cidade: 'Curitiba' } });
    expect(p.rows[0]?.phone?.e164).toBe('5541998765432');
    expect(p.rows[3]?.error).toBe('sem_ddd');
  });

  it('conta válidos, repetidos, inválidos e bloqueados, com o motivo de cada rejeição', async () => {
    const p = await prepareRows(table, mapping);
    const fin = finalizeRows(
      p.rows,
      {
        blocked: new Set(['5521999990000']),
        existing: new Map([['5531988887777', { listName: 'Lista antiga', called: true }]]),
      },
      { inFile: true, base: 'todos' },
    );
    expect(fin.counts).toEqual({
      total: 8,
      valid: 2,
      invalid: 3,
      duplicatesInFile: 1,
      duplicatesInBase: 1,
      blocked: 1,
      companies: 2,
      phones: 2,
    });
    expect(fin.rejected.map((r) => [r.rowNumber, r.reason])).toEqual([
      [4, 'Repetido no arquivo (mesmo telefone da linha 2)'],
      [5, 'Telefone sem DDD (preencha o DDD padrão)'],
      [6, 'Telefone inválido'],
      [7, 'Sem telefone'],
      [8, 'Número na lista de não contatar'],
      [9, 'Já foi chamado (lista "Lista antiga")'],
    ]);
  });

  it('DDD padrão resolve os números sem DDD', async () => {
    const p = await prepareRows(table, { ...mapping, defaultDdd: '41' });
    expect(p.rows[3]?.phone?.e164).toBe('5541998761111');
  });

  it('deduplicação configurável', async () => {
    const p = await prepareRows(table, mapping);
    const lookup = {
      blocked: new Set<string>(),
      existing: new Map([['5531988887777', { listName: 'L', called: false }]]),
    };
    const noDedupe = finalizeRows(p.rows, lookup, { inFile: false, base: 'nenhum' });
    expect(noDedupe.counts.valid).toBe(5);
    expect(noDedupe.counts.duplicatesInFile).toBe(0);
    expect(noDedupe.counts.duplicatesInBase).toBe(0);
  });

  it('sem coluna de nome', async () => {
    const p = await prepareRows(table, { ...mapping, nameColumn: -1 });
    expect(p.rows[0]?.name).toBe('');
    expect(p.extraColumns.map((c) => c.key)).toEqual(['Nome', 'Cidade']);
  });
});

describe('empresas (pessoa jurídica)', () => {
  const table = readTable(
    Buffer.from(
      [
        'Razão social;Sócio;WhatsApp;Cidade',
        'Padaria Sol Ltda;Maria Silva;(41) 99876-5432 / (41) 3333-4444;Curitiba',
        'Padaria Sol Ltda;João Silva;41 99876-1111;Curitiba',
        'Oficina Lua ME;Ana Souza;11 91234-5678;São Paulo',
      ].join('\n'),
    ),
    'pj.csv',
  );

  it('guarda a empresa separada do sócio e conta empresas e telefones', async () => {
    const p = await prepareRows(table, {
      hasHeader: true,
      companyColumn: 0,
      nameColumn: 1,
      phoneColumn: 2,
      defaultDdd: null,
    });
    expect(p.rows[0]).toMatchObject({ company: 'Padaria Sol Ltda', name: 'Maria Silva' });
    expect(p.extraColumns.map((c) => c.key)).toEqual(['Cidade']);
    const fin = finalizeRows(
      p.rows,
      { blocked: new Set(), existing: new Map() },
      { inFile: true, base: 'todos' },
    );
    expect(fin.counts).toMatchObject({ valid: 3, companies: 2, phones: 4 });
  });
});
