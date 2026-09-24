import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvCell, csvLine } from '../../src/server/lib/csv';
import {
  decodeText,
  detectDelimiter,
  parseCsvText,
  parseDelimited,
} from '../../src/server/modules/imports/csv-parse';
import { readTable } from '../../src/server/modules/imports/read-file';

describe('detecção do separador', () => {
  it.each([
    ['Nome;Telefone;Cidade\nMaria;41 99876-5432;Curitiba\nJoão;11 91234-5678;São Paulo', ';'],
    ['Nome,Telefone,Cidade\nMaria,41 99876-5432,Curitiba\nJoão,11 91234-5678,São Paulo', ','],
    ['Nome\tTelefone\nMaria\t41 99876-5432\nJoão\t11 91234-5678', '\t'],
    ['Nome|Telefone\nMaria|41 99876-5432\nJoão|11 91234-5678', '|'],
  ])('%#', (text, delim) => {
    expect(detectDelimiter(text)).toBe(delim);
  });

  it('prefere ; quando há vírgula decimal dentro dos valores', () => {
    const text =
      'Nome;Telefone;Valor\nMaria;41 99876-5432;1500,50\nJoão;11 91234-5678;99,90\nAna;11 98888-7777;10';
    expect(detectDelimiter(text)).toBe(';');
  });

  it('ignora separadores dentro de aspas', () => {
    const text = 'Nome,Telefone\n"Silva; Maria",41 99876-5432\n"Souza; João",11 91234-5678';
    expect(detectDelimiter(text)).toBe(',');
  });

  it('respeita a linha sep= do Excel', () => {
    const r = parseCsvText('sep=|\nNome|Telefone\nMaria|41 99876-5432');
    expect(r.delimiter).toBe('|');
    expect(r.rows).toEqual([
      ['Nome', 'Telefone'],
      ['Maria', '41 99876-5432'],
    ]);
  });
});

describe('leitura de CSV', () => {
  it('lida com aspas, aspas duplicadas, separador e quebra de linha dentro de aspas', () => {
    const text = 'Nome;Obs\n"Maria ""Mari"" Silva";"linha 1\nlinha 2"\n"Ana; Paula";ok\r\nJoão;"fim"';
    expect(parseDelimited(text, ';')).toEqual([
      ['Nome', 'Obs'],
      ['Maria "Mari" Silva', 'linha 1\nlinha 2'],
      ['Ana; Paula', 'ok'],
      ['João', 'fim'],
    ]);
  });

  it('aceita CRLF, CR e linha final sem quebra', () => {
    expect(parseDelimited('a;b\r\nc;d\re;f', ';')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('não cria linha vazia no fim do arquivo', () => {
    expect(parseDelimited('a;b\nc;d\n', ';')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('mantém campos vazios', () => {
    expect(parseDelimited('a;;c\n;;', ';')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ]);
  });
});

describe('codificação', () => {
  it('lê UTF-8 com BOM', () => {
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Nome;Cidade\nJoão;São Paulo', 'utf8'),
    ]);
    expect(decodeText(buf)).toBe('Nome;Cidade\nJoão;São Paulo');
  });

  it('lê Windows-1252 (Excel antigo em português)', () => {
    // "João;São Paulo;Ação" em Windows-1252
    const buf = Buffer.from([
      0x4a, 0x6f, 0xe3, 0x6f, 0x3b, 0x53, 0xe3, 0x6f, 0x20, 0x50, 0x61, 0x75, 0x6c, 0x6f, 0x3b, 0x41, 0xe7,
      0xe3, 0x6f,
    ]);
    expect(decodeText(buf)).toBe('João;São Paulo;Ação');
  });

  it('lê UTF-16 (Excel "Texto Unicode")', () => {
    const body = Buffer.from('Nome\tTelefone\nJoão\t41 99876-5432', 'utf16le');
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
    expect(decodeText(buf)).toBe('Nome\tTelefone\nJoão\t41 99876-5432');
  });

  it('lê um arquivo .csv inteiro em Windows-1252 com ;', () => {
    const latin1 = Buffer.from('Nome;Telefone\nJos\xe9 Concei\xe7\xe3o;(41) 99876-5432\n', 'latin1');
    const t = readTable(latin1, 'lista.csv');
    expect(t.rows.map((r) => r.cells)).toEqual([
      ['Nome', 'Telefone'],
      ['José Conceição', '(41) 99876-5432'],
    ]);
  });

  it('numera as linhas como no arquivo e pula linhas vazias', () => {
    const t = readTable(Buffer.from('Nome;Tel\n\nMaria;41 99876-5432\n;\nJoão;11 91234-5678'), 'x.csv');
    expect(t.rows.map((r) => r.n)).toEqual([1, 3, 5]);
  });
});

describe('CSV de saída (Excel em português)', () => {
  it('usa ; e aspas quando precisa', () => {
    expect(csvLine(['a', 'b;c', 'd"e', 'f\ng'])).toBe('a;"b;c";"d""e";"f\ng"\r\n');
    expect(CSV_BOM).toBe('﻿');
  });

  it('neutraliza fórmulas (injeção de CSV), mas não telefones e números', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SOMA(A1)')).toBe("'@SOMA(A1)");
    expect(csvCell('+55 41 99876-5432')).toBe('+55 41 99876-5432');
    expect(csvCell('-10')).toBe('-10');
    expect(csvCell(null)).toBe('');
  });
});
