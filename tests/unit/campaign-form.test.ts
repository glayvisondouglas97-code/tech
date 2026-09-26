import { describe, expect, it } from 'vitest';
import type { CampaignEstimate } from '../../src/shared/campaign-plan';
import {
  changesFrom,
  describeFilters,
  describePeriod,
  estimateText,
  filtersOf,
  formProblems,
  formToInput,
  initialForm,
  parseDdds,
} from '../../src/web/lib/campaign-form';
import { fmtYmd } from '../../src/web/lib/format';

// O formulário da campanha: só monta, confere e descreve o que a pessoa digitou. Quem decide é o servidor.

const TODAY = '2026-09-25'; // sexta-feira
const base = () => ({ ...initialForm(), listId: 'lista-1', numbers: [1, 2] });

describe('formulário da campanha: padrões', () => {
  it('nasce com 10:00 às 16:00, segunda a sexta, 20 por número, cooldown de 24h e sem filtros', () => {
    const f = initialForm();
    expect(f).toMatchObject({
      windowStart: '10:00',
      windowEnd: '16:00',
      limitText: '20',
      days: [1, 2, 3, 4, 5],
      cooldownText: '24',
      when: 'now',
      endDate: '',
      status: ['pendente'],
    });
    expect(filtersOf(f)).toEqual({});
  });

  it('o corpo da API leva tudo: datas do calendário (nunca de outro dia), dias e cooldown', () => {
    const input = formToInput(
      { ...base(), when: 'scheduled', startDate: '2026-10-01', endDate: '2026-10-31' },
      TODAY,
    );
    expect(input).toEqual({
      listId: 'lista-1',
      instanceIds: [1, 2],
      windowStart: '10:00',
      windowEnd: '16:00',
      dailyLimitPerNumber: 20,
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      daysOfWeek: [1, 2, 3, 4, 5],
      cooldownHours: 24,
      filters: {},
    });
  });

  it('"Iniciar agora" começa hoje (São Paulo) e sem data final manda null', () => {
    expect(formToInput(base(), TODAY)).toMatchObject({ startDate: TODAY, endDate: null });
  });
});

describe('formulário da campanha: o que impede de seguir', () => {
  it('lista e número são obrigatórios', () => {
    expect(formProblems(initialForm(), TODAY)).toEqual(['Escolha a lista.', 'Escolha pelo menos um número.']);
    expect(formToInput(initialForm(), TODAY)).toBeNull();
  });

  it('horário: o fim precisa ser depois do início (10:00 = 10:00 não vale)', () => {
    expect(formProblems({ ...base(), windowStart: '16:00', windowEnd: '10:00' }, TODAY)).toContain(
      'O fim do horário de trabalho precisa ser depois do início.',
    );
    expect(formProblems({ ...base(), windowStart: '10:00', windowEnd: '10:00' }, TODAY)).toHaveLength(1);
    expect(formProblems({ ...base(), windowStart: '', windowEnd: '16:00' }, TODAY)).toHaveLength(1);
  });

  it('limite por número de 1 a 20; cooldown de 0 a 720 horas', () => {
    for (const limit of ['0', '21', '', 'x', '1,5']) {
      expect(formProblems({ ...base(), limitText: limit }, TODAY), limit).toHaveLength(1);
    }
    for (const limit of ['1', '20', ' 7 '])
      expect(formProblems({ ...base(), limitText: limit }, TODAY)).toEqual([]);
    for (const cooldown of ['721', '', '-1', 'a']) {
      expect(formProblems({ ...base(), cooldownText: cooldown }, TODAY), cooldown).toHaveLength(1);
    }
    for (const cooldown of ['0', '24', '720']) {
      expect(formProblems({ ...base(), cooldownText: cooldown }, TODAY)).toEqual([]);
    }
  });

  it('pelo menos um dia da semana', () => {
    expect(formProblems({ ...base(), days: [] }, TODAY)).toEqual(['Escolha pelo menos um dia da semana.']);
  });

  it('agendar exige uma data DEPOIS de hoje; a data final não pode ser antes do início nem do passado', () => {
    const scheduled = { ...base(), when: 'scheduled' as const };
    expect(formProblems(scheduled, TODAY)).toEqual(['Escolha a data de início da campanha agendada.']);
    expect(formProblems({ ...scheduled, startDate: TODAY }, TODAY)).toHaveLength(1);
    expect(formProblems({ ...scheduled, startDate: '2026-09-24' }, TODAY)).toHaveLength(1);
    expect(formProblems({ ...scheduled, startDate: '2026-09-26' }, TODAY)).toEqual([]);
    expect(formProblems({ ...scheduled, startDate: '2026-10-05', endDate: '2026-10-01' }, TODAY)).toEqual([
      'A data final não pode ser antes da data de início.',
    ]);
    expect(formProblems({ ...base(), endDate: '2026-09-24' }, TODAY)).toEqual(['A data final já passou.']);
    expect(formProblems({ ...base(), endDate: TODAY }, TODAY)).toEqual([]); // hoje vale (a data final é inclusiva)
  });

  it('DDD: dois dígitos, sem repetir, e o que sobra de errado é avisado', () => {
    expect(parseDdds('41, 42;41  11')).toEqual({ ddds: ['41', '42', '11'], invalid: [] });
    expect(parseDdds('4, 041, ab, 41')).toEqual({ ddds: ['41'], invalid: ['4', '041', 'ab'] });
    expect(formProblems({ ...base(), dddText: '4' }, TODAY)[0]).toMatch(/^DDD inválido: 4\./);
    expect(parseDdds('')).toEqual({ ddds: [], invalid: [] });
  });
});

describe('formulário da campanha: filtros', () => {
  it('só entra na API o que restringe de verdade (o padrão "só pendente" e "tanto faz" ficam de fora)', () => {
    expect(filtersOf({ ...base(), calledBefore: 'any', status: ['pendente'] })).toEqual({});
    expect(filtersOf({ ...base(), dddText: '41, 41, 42' })).toEqual({ ddd: ['41', '42'] });
    expect(filtersOf({ ...base(), status: ['pendente', 'chamado'] })).toEqual({
      status: ['pendente', 'chamado'],
    });
    expect(filtersOf({ ...base(), status: ['chamado'], results: ['nao_respondeu'] })).toEqual({
      status: ['chamado'],
      result: ['nao_respondeu'],
    });
    expect(filtersOf({ ...base(), phoneTypes: ['fixo'], calledBefore: 'never' })).toEqual({
      phoneType: ['fixo'],
      calledBefore: 'never',
    });
  });

  it('descreve os filtros em palavras (o resumo final usa)', () => {
    expect(describeFilters({})).toEqual([]);
    expect(
      describeFilters({
        ddd: ['41'],
        status: ['chamado'],
        result: ['nao_respondeu'],
        phoneType: ['movel'],
        calledBefore: 'never',
      }),
    ).toEqual([
      'DDD 41',
      'Situação: Já chamado',
      'Resultado: Cliente não respondeu',
      'Telefone: Celular',
      'Chamado antes: Nunca chamado',
    ]);
  });
});

describe('editar: só o que mudou', () => {
  const original = () => ({
    ...base(),
    windowStart: '10:00',
    windowEnd: '16:00',
    when: 'now' as const,
    startDate: '2026-09-20',
  });

  it('nada mudou → nada a enviar', () => {
    expect(changesFrom(original(), original())).toEqual({});
  });

  it('cada campo mudado vai sozinho; a data inicial de uma campanha já em andamento não vai', () => {
    expect(changesFrom(original(), { ...original(), windowEnd: '17:00' })).toEqual({ windowEnd: '17:00' });
    expect(changesFrom(original(), { ...original(), days: [1, 2, 3] })).toEqual({ daysOfWeek: [1, 2, 3] });
    expect(changesFrom(original(), { ...original(), cooldownText: '48' })).toEqual({ cooldownHours: 48 });
    expect(changesFrom(original(), { ...original(), numbers: [2, 3] })).toEqual({ instanceIds: [2, 3] });
    expect(changesFrom(original(), { ...original(), limitText: '10' })).toEqual({ dailyLimitPerNumber: 10 });
    expect(changesFrom(original(), { ...original(), endDate: '2026-12-31' })).toEqual({
      endDate: '2026-12-31',
    });
    expect(changesFrom(original(), { ...original(), dddText: '41' })).toEqual({ filters: { ddd: ['41'] } });
    // Tirar a data final manda null (sem data final).
    expect(changesFrom({ ...original(), endDate: '2026-12-31' }, original())).toEqual({ endDate: null });
  });

  it('formulário com problema não gera alteração', () => {
    expect(changesFrom(original(), { ...original(), windowEnd: '09:00' })).toEqual({});
  });
});

describe('textos', () => {
  const estimate = (over: Partial<CampaignEstimate>): CampaignEstimate => ({
    status: 'ok',
    eligible: 100,
    connectedNumbers: 3,
    capacityToday: 60,
    capacityPerDay: 60,
    runDays: 2,
    firstDay: '2026-10-01',
    lastDay: '2026-10-02',
    leftover: 0,
    ...over,
  });

  it('a estimativa é sempre "aproximada" e nunca promete uma data', () => {
    expect(estimateText(estimate({}))).toBe(
      'Estimativa aproximada: cerca de 2 dias de execução, de 01/10/2026 a 02/10/2026.',
    );
    expect(estimateText(estimate({ runDays: 1, lastDay: '2026-10-01' }))).toMatch(
      /^Estimativa aproximada: cerca de 1 dia de execução/,
    );
    expect(estimateText(estimate({ status: 'beyond_end_date', leftover: 40 }))).toBe(
      'Estimativa aproximada: até a data final devem ser atendidos 60 de 100 leads; 40 ficariam de fora.',
    );
    expect(estimateText(estimate({ status: 'too_long' }))).toMatch(/mais de um ano/);
    expect(estimateText(estimate({ status: 'no_audience' }))).toMatch(/Nenhum lead elegível/);
    expect(estimateText(estimate({ status: 'no_capacity' }))).toMatch(/Nenhum número conectado/);
  });

  it('datas do calendário aparecem como dd/mm/aaaa sem passar por fuso', () => {
    expect(fmtYmd('2026-10-01')).toBe('01/10/2026');
    expect(fmtYmd('2026-12-31')).toBe('31/12/2026');
    expect(fmtYmd(null)).toBe('');
    expect(fmtYmd('2026-10-01T00:00:00Z')).toBe('');
    expect(describePeriod('2026-10-01', '2026-10-31')).toBe('01/10/2026 a 31/10/2026');
    expect(describePeriod('2026-10-01', null)).toBe('a partir de 01/10/2026 · sem data final');
  });
});
