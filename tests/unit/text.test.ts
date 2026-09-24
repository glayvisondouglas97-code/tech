import { describe, expect, it } from 'vitest';
import { formatPhoneBR } from '../../src/shared/phone-format';
import { columnLetter, initials, normalizeText } from '../../src/shared/text';

describe('utilitários de texto', () => {
  it('formata telefone brasileiro', () => {
    expect(formatPhoneBR('5541998765432')).toBe('(41) 99876-5432');
    expect(formatPhoneBR('554133334444')).toBe('(41) 3333-4444');
    expect(formatPhoneBR('12133734253')).toBe('+12133734253');
  });
  it('normaliza texto para busca', () => {
    expect(normalizeText('  São   PAULO ')).toBe('sao paulo');
  });
  it('iniciais e letras de coluna', () => {
    expect(initials('Maria da Silva')).toBe('MS');
    expect(initials('')).toBe('?');
    expect([0, 25, 26, 27, 701].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ']);
  });
});
