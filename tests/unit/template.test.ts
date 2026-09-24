import { describe, expect, it } from 'vitest';
import { formatPhoneBR } from '../../src/shared/phone-format';
import { DEFAULT_TEMPLATE, fillTemplate, firstName } from '../../src/shared/template';
import { columnLetter, initials, normalizeText } from '../../src/shared/text';
import { whatsappLink } from '../../src/shared/whatsapp';

describe('mensagem pronta', () => {
  it('usa o primeiro nome com inicial maiúscula', () => {
    expect(firstName('MARIA DA SILVA')).toBe('Maria');
    expect(firstName('  élida souza')).toBe('Élida');
    expect(firstName('')).toBe('');
  });

  it('preenche {nome}, {nome_completo}, {atendente} e colunas extras', () => {
    const t = 'Olá, {nome}! Sou {atendente}. {Nome_Completo}, vi seu interesse em {Interesse} ({cidade}).';
    const out = fillTemplate(
      t,
      { name: 'maria da silva', extra: { Interesse: 'Plano anual', Cidade: 'Curitiba' } },
      'Ana',
    );
    expect(out).toBe('Olá, Maria! Sou Ana. maria da silva, vi seu interesse em Plano anual (Curitiba).');
  });

  it('acha coluna extra sem diferenciar acentos, maiúsculas e espaço/sublinhado', () => {
    const out = fillTemplate(
      '{produto_de_interesse} em {Região}',
      { name: 'x', extra: { 'Produto de interesse': 'Seguro', regiao: 'Sul' } },
      '',
    );
    expect(out).toBe('Seguro em Sul');
  });

  it('não deixa "Olá, !" quando o nome está vazio', () => {
    expect(fillTemplate(DEFAULT_TEMPLATE, { name: '' }, 'Ana')).toMatch(/^Olá! Tudo bem\? Aqui é Ana\./);
  });

  it('preenche {empresa} com o nome da empresa e {nome} com o sócio', () => {
    const out = fillTemplate(
      'Olá, {nome}! Falo com a {empresa}?',
      { name: 'MARIA SILVA', company: 'Padaria Sol Ltda' },
      'Ana',
    );
    expect(out).toBe('Olá, Maria! Falo com a Padaria Sol Ltda?');
  });

  it('variável desconhecida vira vazio', () => {
    expect(fillTemplate('Oi {xyz}!', { name: 'Maria' }, 'Ana')).toBe('Oi !');
  });
});

describe('link do WhatsApp', () => {
  it('wa.me com o número no caminho e a mensagem', () => {
    const url = whatsappLink('5541998765432', 'Olá, Maria! Tudo bem?');
    expect(url.startsWith('https://wa.me/5541998765432?text=')).toBe(true);
    expect(url).not.toContain('+');
    expect(new URL(url).searchParams.get('text')).toBe('Olá, Maria! Tudo bem?');
  });

  it('sem mensagem', () => {
    expect(whatsappLink('+55 (41) 99876-5432', null)).toBe('https://wa.me/5541998765432');
  });

  it('mantém o + literal da mensagem', () => {
    expect(whatsappLink('551199', 'a+b c')).toContain('text=a%2Bb%20c');
  });
});

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
