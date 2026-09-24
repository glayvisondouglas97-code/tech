import { describe, expect, it } from 'vitest';
import {
  describeColumns,
  detectColumns,
  detectHeader,
  looksLikePhone,
} from '../../src/server/modules/imports/detect';

describe('parece telefone', () => {
  it.each([
    ['(41) 99876-5432', true],
    ['99876-5432', true],
    ['+55 41 99876-5432', true],
    ['41 99876-5432 / 41 3333-4444', true],
    ['123.456.789-09', false],
    ['12.345.678/0001-90', false],
    ['15/01/2024', false],
    ['2024-01-15', false],
    ['maria@email.com', false],
    ['Maria Silva', false],
    ['80010-000', false],
    ['', false],
  ])('%s → %s', (v, expected) => {
    expect(looksLikePhone(v)).toBe(expected);
  });
});

describe('cabeçalho e colunas', () => {
  const withHeader = [
    ['Cidade', 'Nome completo', 'E-mail', 'WhatsApp'],
    ['Curitiba', 'Maria Silva', 'maria@x.com', '(41) 99876-5432'],
    ['Londrina', 'João Souza', 'joao@x.com', '43 99123-4567'],
    ['Campinas', 'Ana Lima', 'ana@x.com', '19 98765-1234'],
  ];

  it('detecta o cabeçalho quando a primeira linha não tem telefone', () => {
    expect(detectHeader(withHeader)).toBe(true);
    expect(detectHeader(withHeader.slice(1))).toBe(false);
  });

  it('acha nome e telefone pelo título e pelo conteúdo', () => {
    expect(detectColumns(withHeader, true)).toEqual({ phone: 3, company: -1, name: 1 });
  });

  it('acha nome e telefone sem cabeçalho, só pelo conteúdo', () => {
    const rows = [
      ['41 99876-5432', 'Maria Silva', '123.456.789-09'],
      ['43 99123-4567', 'João Souza', '987.654.321-00'],
    ];
    expect(detectHeader(rows)).toBe(false);
    expect(detectColumns(rows, false)).toEqual({ phone: 0, company: -1, name: 1 });
  });

  it('não confunde CPF com telefone', () => {
    const rows = [
      ['Nome', 'CPF', 'Celular'],
      ['Maria', '123.456.789-09', '41 99876-5432'],
      ['João', '987.654.321-00', '11 91234-5678'],
    ];
    expect(detectColumns(rows, true).phone).toBe(2);
  });

  it('prefere a coluna de nome à de cidade', () => {
    const rows = [
      ['Cidade', 'Cliente', 'Telefone'],
      ['São Paulo', 'Maria Silva', '11 91234-5678'],
      ['Rio de Janeiro', 'João Souza', '21 99876-5432'],
    ];
    expect(detectColumns(rows, true)).toEqual({ phone: 2, company: -1, name: 1 });
  });

  it('rotula as colunas e evita títulos repetidos', () => {
    const cols = describeColumns([['Nome', 'Telefone', 'Telefone', '']], true, 4);
    expect(cols.map((c) => c.label)).toEqual(['Nome', 'Telefone', 'Telefone (2)', 'Coluna D']);
    expect(describeColumns([['a', 'b']], false, 2).map((c) => c.label)).toEqual(['Coluna A', 'Coluna B']);
  });

  it('acha a coluna da empresa pelo título e pelo conteúdo (Ltda, ME...)', () => {
    const withHeader = [
      ['Razão social', 'Sócio', 'Celular'],
      ['Padaria Sol Ltda', 'Maria Silva', '41 99876-5432'],
      ['Oficina Lua ME', 'João Souza', '11 91234-5678'],
    ];
    expect(detectColumns(withHeader, true)).toEqual({ phone: 2, company: 0, name: 1 });
    const noHeader = withHeader.slice(1).map((r) => [r[1] as string, r[2] as string, r[0] as string]);
    expect(detectColumns(noHeader, false)).toEqual({ phone: 1, company: 2, name: 0 });
  });
});
