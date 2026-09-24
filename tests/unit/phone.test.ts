import { describe, expect, it } from 'vitest';
import { displayPhone, normalizePhones } from '../../src/server/modules/imports/phone';

const main = (raw: unknown, ddd?: string) => normalizePhones(raw, ddd ?? null).phones[0]?.e164 ?? null;

describe('normalização de telefone (E.164)', () => {
  it.each([
    ['(41) 99876-5432', '5541998765432'],
    ['41998765432', '5541998765432'],
    ['41 9 9876-5432', '5541998765432'],
    ['+55 41 99876-5432', '5541998765432'],
    ['5541998765432', '5541998765432'],
    ['55 (41) 99876-5432', '5541998765432'],
    ['041 99876-5432', '5541998765432'],
    ['0041 99876-5432', null],
    ['0 15 41 99876-5432', '5541998765432'],
    ['(21) 2345-6789', '552123456789'],
    ['4133334444', '554133334444'],
  ])('%s → %s', (raw, expected) => {
    expect(main(raw)).toBe(expected);
  });

  it('aceita número vindo do Excel como número (sem notação científica)', () => {
    expect(main(5541998765432)).toBe('5541998765432');
    expect(main(41998765432)).toBe('5541998765432');
  });

  it('acrescenta o 9 em celular antigo com 8 dígitos', () => {
    expect(main('41 8876-5432')).toBe('5541988765432');
    expect(main('55 41 8876-5432')).toBe('5541988765432');
    expect(main('+55 41 8876-5432')).toBe('5541988765432');
    // fixo (começa com 2 a 5) não ganha o 9
    expect(main('41 3333-4444')).toBe('554133334444');
  });

  it('usa o DDD padrão só quando o número vem sem DDD', () => {
    expect(main('99876-5432', '41')).toBe('5541998765432');
    expect(main('9876-5432', '41')).toBe('5541998765432');
    expect(main('3333-4444', '11')).toBe('551133334444');
    expect(main('(21) 99876-5432', '41')).toBe('5521998765432');
    expect(normalizePhones('99876-5432', null)).toEqual({ phones: [], error: 'sem_ddd' });
  });

  it('ignora DDD padrão inválido', () => {
    expect(normalizePhones('99876-5432', '4')).toEqual({ phones: [], error: 'sem_ddd' });
  });

  it('trata vários números na mesma célula, celular primeiro', () => {
    const r = normalizePhones('(11) 3456-7890 / (11) 91234-5678');
    expect(r.phones.map((p) => p.e164)).toEqual(['5511912345678', '551134567890']);
    expect(r.phones.map((p) => p.kind)).toEqual(['movel', 'fixo']);
    expect(main('11 3456-7890 ou 11 91234-5678')).toBe('5511912345678');
    expect(main('11 91234-5678; 11 98888-7777')).toBe('5511912345678');
    expect(main('41998765432 41988887777')).toBe('5541998765432');
    expect(normalizePhones('41998765432 41988887777').phones).toHaveLength(2);
  });

  it('não repete o mesmo número da célula', () => {
    expect(normalizePhones('41998765432 / (41) 99876-5432').phones).toHaveLength(1);
  });

  it('aproveita o número válido quando outro da célula é inválido', () => {
    expect(main('123 / 41 99876-5432')).toBe('5541998765432');
  });

  it('rejeita o que não é telefone', () => {
    expect(normalizePhones('')).toEqual({ phones: [], error: 'vazio' });
    expect(normalizePhones(null)).toEqual({ phones: [], error: 'vazio' });
    expect(normalizePhones('sem telefone')).toEqual({ phones: [], error: 'invalido' });
    expect(normalizePhones('123').error).toBe('invalido');
    expect(normalizePhones('123.456.789-09').error).toBe('invalido');
    expect(normalizePhones('0800 123 4567').error).toBe('invalido');
    expect(normalizePhones('(00) 90000-0001').error).toBe('invalido');
    expect(normalizePhones('11 81234-5678 9').error).toBe('invalido');
  });

  it('aceita números internacionais com + ou 00', () => {
    expect(main('+1 213 373 4253')).toBe('12133734253');
    expect(main('+351 912 345 678')).toBe('351912345678');
    expect(main('00351 912 345 678')).toBe('351912345678');
  });

  it('marca o tipo do telefone', () => {
    expect(normalizePhones('41998765432').phones[0]?.kind).toBe('movel');
    expect(normalizePhones('4133334444').phones[0]?.kind).toBe('fixo');
  });

  it('formata para exibição', () => {
    expect(displayPhone('5541998765432')).toBe('(41) 99876-5432');
    expect(displayPhone('554133334444')).toBe('(41) 3333-4444');
    expect(displayPhone('12133734253')).toBe('+1 213 373 4253');
    expect(displayPhone('')).toBe('');
  });
});
