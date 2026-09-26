import { describe, expect, it } from 'vitest';
import {
  buildCalendar,
  type CapacityNumber,
  capacityPerDay,
  capacityToday,
  estimateDuration,
  MAX_ESTIMATE_DAYS,
} from '../../src/server/modules/automations/capacity';
import { campaignCreateSchema, campaignUpdateSchema } from '../../src/server/modules/automations/validation';
import {
  dayAllowed,
  followUpSchedule,
  insideSchedule,
  isoWeekday,
  nextScheduleOpening,
  type Schedule,
  scheduleOf,
  spInstant,
  spTime,
  ymd,
} from '../../src/server/modules/automations/window';
import {
  ALL_DAYS,
  DEFAULT_DAYS,
  formatDays,
  normalizeDays,
  normalizeFilters,
} from '../../src/shared/campaign-plan';

// Agenda da campanha (dias da semana, datas, horário), capacidade, estimativa e calendário: contas puras, todas no
// calendário de São Paulo. Nada aqui usa o relógio nem o fuso da máquina que roda o teste.

/** Instante de São Paulo: data AAAA-MM-DD, hora e minuto. */
const at = (date: string, hh: number, mm = 0, ss = 0) =>
  new Date(spInstant(date, hh * 60 + mm).getTime() + ss * 1000);

/** Segunda a sexta, das 10:00 às 16:00, sem datas. */
const weekdays: Schedule = { startMin: 600, endMin: 960, days: DEFAULT_DAYS, startDate: null, endDate: null };
const iso = (d: Date | null) => (d ? d.toISOString() : null);

describe('dia da semana e datas em São Paulo', () => {
  it('isoWeekday: 1 = segunda ... 7 = domingo', () => {
    expect(isoWeekday('2026-03-09')).toBe(1); // segunda
    expect(isoWeekday('2026-03-10')).toBe(2);
    expect(isoWeekday('2026-03-13')).toBe(5); // sexta
    expect(isoWeekday('2026-03-14')).toBe(6); // sábado
    expect(isoWeekday('2026-03-15')).toBe(7); // domingo
    expect(isoWeekday('2000-01-01')).toBe(6);
    expect(isoWeekday('2028-02-29')).toBe(2); // ano bissexto
  });

  it('o dia da semana é o de São Paulo, não o de UTC', () => {
    // 02:00Z de terça (10/03) ainda é segunda à noite (09/03, 23:00) em São Paulo.
    const utcTuesday = new Date('2026-03-10T02:00:00Z');
    expect(spTime(utcTuesday).date).toBe('2026-03-09');
    expect(dayAllowed(spTime(utcTuesday).date, { ...weekdays, days: [1] })).toBe(true);
    expect(dayAllowed(spTime(utcTuesday).date, { ...weekdays, days: [2] })).toBe(false);
  });

  it('ymd lê a data do banco (Date à meia-noite local) sem escorregar de dia', () => {
    expect(ymd(new Date(2026, 9, 1))).toBe('2026-10-01'); // 1º de outubro, construído com getters locais
    expect(ymd(new Date(2026, 0, 31))).toBe('2026-01-31');
    expect(ymd('2026-10-01')).toBe('2026-10-01');
    expect(ymd('2026-10-01T00:00:00.000Z')).toBe('2026-10-01');
  });

  it('dayAllowed: dia da semana permitido E dentro das datas (inclusive nas pontas)', () => {
    const s: Schedule = { ...weekdays, startDate: '2026-10-01', endDate: '2026-10-15' };
    expect(dayAllowed('2026-09-30', s)).toBe(false); // antes da data inicial (quarta)
    expect(dayAllowed('2026-10-01', s)).toBe(true); // a data inicial conta (quinta)
    expect(dayAllowed('2026-10-03', s)).toBe(false); // sábado
    expect(dayAllowed('2026-10-04', s)).toBe(false); // domingo
    expect(dayAllowed('2026-10-05', s)).toBe(true);
    expect(dayAllowed('2026-10-15', s)).toBe(true); // a data final conta (quinta)
    expect(dayAllowed('2026-10-16', s)).toBe(false); // depois da data final
  });

  it('sem data final a campanha não tem fim; sem data inicial vale desde sempre', () => {
    expect(dayAllowed('2031-05-07', weekdays)).toBe(true); // quarta, muito à frente
    expect(dayAllowed('2020-01-01', weekdays)).toBe(true); // quarta, no passado
  });
});

describe('dentro da agenda: horário [10:00, 16:00) e dias', () => {
  it('10:00 permitido, 15:59 permitido, 16:00 não', () => {
    expect(insideSchedule(at('2026-03-10', 9, 59, 59), weekdays)).toBe(false);
    expect(insideSchedule(at('2026-03-10', 10, 0, 0), weekdays)).toBe(true);
    expect(insideSchedule(at('2026-03-10', 15, 59, 59), weekdays)).toBe(true);
    expect(insideSchedule(at('2026-03-10', 16, 0, 0), weekdays)).toBe(false);
  });

  it('sábado e domingo: fora, mesmo dentro do horário (padrão segunda a sexta)', () => {
    expect(insideSchedule(at('2026-03-13', 12), weekdays)).toBe(true); // sexta
    expect(insideSchedule(at('2026-03-14', 12), weekdays)).toBe(false); // sábado
    expect(insideSchedule(at('2026-03-15', 12), weekdays)).toBe(false); // domingo
    expect(insideSchedule(at('2026-03-16', 12), weekdays)).toBe(true); // segunda
  });

  it('o gestor pode escolher só o fim de semana', () => {
    const weekend: Schedule = { ...weekdays, days: [6, 7] };
    expect(insideSchedule(at('2026-03-13', 12), weekend)).toBe(false);
    expect(insideSchedule(at('2026-03-14', 12), weekend)).toBe(true);
    expect(insideSchedule(at('2026-03-15', 12), weekend)).toBe(true);
  });

  it('um horário personalizado (13:00 às 14:00)', () => {
    const s: Schedule = { ...weekdays, startMin: 780, endMin: 840 };
    expect(insideSchedule(at('2026-03-10', 12, 59), s)).toBe(false);
    expect(insideSchedule(at('2026-03-10', 13, 0), s)).toBe(true);
    expect(insideSchedule(at('2026-03-10', 14, 0), s)).toBe(false);
  });

  it('antes da data inicial e depois da final: fora', () => {
    const s: Schedule = { ...weekdays, startDate: '2026-03-12', endDate: '2026-03-13' };
    expect(insideSchedule(at('2026-03-11', 12), s)).toBe(false);
    expect(insideSchedule(at('2026-03-12', 12), s)).toBe(true);
    expect(insideSchedule(at('2026-03-13', 12), s)).toBe(true);
    expect(insideSchedule(at('2026-03-16', 12), s)).toBe(false);
  });
});

describe('próxima abertura válida', () => {
  it('dentro da agenda: é o próprio instante', () => {
    const now = at('2026-03-10', 12, 30);
    expect(nextScheduleOpening(now, weekdays)?.getTime()).toBe(now.getTime());
  });

  it('antes do horário: abre hoje; depois do horário: abre no próximo dia permitido', () => {
    expect(iso(nextScheduleOpening(at('2026-03-10', 8), weekdays))).toBe(iso(at('2026-03-10', 10)));
    expect(iso(nextScheduleOpening(at('2026-03-10', 16, 0), weekdays))).toBe(iso(at('2026-03-11', 10)));
    // "Agora 18:30, janela 10:00–16:00: próxima execução amanhã às 10:00".
    expect(iso(nextScheduleOpening(at('2026-03-10', 18, 30), weekdays))).toBe(iso(at('2026-03-11', 10)));
  });

  it('se amanhã não é dia permitido, pula para o próximo dia permitido (sexta à noite → segunda)', () => {
    expect(iso(nextScheduleOpening(at('2026-03-13', 18, 30), weekdays))).toBe(iso(at('2026-03-16', 10)));
    expect(iso(nextScheduleOpening(at('2026-03-14', 12), weekdays))).toBe(iso(at('2026-03-16', 10))); // sábado
    expect(iso(nextScheduleOpening(at('2026-03-15', 9), weekdays))).toBe(iso(at('2026-03-16', 10))); // domingo
  });

  it('dia da semana escolhido à mão (só quarta): pula os outros dias', () => {
    const s: Schedule = { ...weekdays, days: [3] };
    expect(iso(nextScheduleOpening(at('2026-03-10', 12), s))).toBe(iso(at('2026-03-11', 10)));
    expect(iso(nextScheduleOpening(at('2026-03-11', 17), s))).toBe(iso(at('2026-03-18', 10)));
  });

  it('data inicial no futuro: a primeira abertura é na data inicial (ou no primeiro dia permitido depois dela)', () => {
    const future: Schedule = { ...weekdays, startDate: '2026-10-01' }; // quinta
    expect(iso(nextScheduleOpening(at('2026-03-10', 12), future))).toBe(iso(at('2026-10-01', 10)));
    const onSaturday: Schedule = { ...weekdays, startDate: '2026-10-03' }; // sábado: vai para segunda
    expect(iso(nextScheduleOpening(at('2026-10-01', 12), onSaturday))).toBe(iso(at('2026-10-05', 10)));
  });

  it('passou da data final: não há mais abertura (null)', () => {
    const s: Schedule = { ...weekdays, endDate: '2026-03-13' };
    expect(nextScheduleOpening(at('2026-03-13', 12), s)).not.toBeNull(); // ainda é o último dia
    expect(nextScheduleOpening(at('2026-03-13', 17), s)).toBeNull(); // o último dia acabou
    expect(nextScheduleOpening(at('2026-03-16', 8), s)).toBeNull();
  });

  it('virada do dia: perto da meia-noite de São Paulo', () => {
    // 23:59:59 de segunda em São Paulo é 02:59:59Z de terça: a próxima abertura é terça 10:00 (SP).
    const lateMonday = new Date('2026-03-10T02:59:59Z');
    expect(spTime(lateMonday).date).toBe('2026-03-09');
    expect(iso(nextScheduleOpening(lateMonday, weekdays))).toBe(iso(at('2026-03-10', 10)));
    // 00:00:00 de terça em São Paulo (03:00Z): ainda antes do horário, abre hoje às 10:00.
    expect(iso(nextScheduleOpening(new Date('2026-03-10T03:00:00Z'), weekdays))).toBe(
      iso(at('2026-03-10', 10)),
    );
  });

  it('virada do mês e do ano', () => {
    // sexta 30/01/2026 à noite → segunda 02/02/2026.
    expect(iso(nextScheduleOpening(at('2026-01-30', 17), weekdays))).toBe(iso(at('2026-02-02', 10)));
    // quinta 31/12/2026 à noite → sexta 01/01/2027.
    expect(iso(nextScheduleOpening(at('2026-12-31', 17), weekdays))).toBe(iso(at('2027-01-01', 10)));
    // fevereiro bissexto: segunda 28/02/2028 → terça 29/02/2028.
    expect(iso(nextScheduleOpening(at('2028-02-28', 17), weekdays))).toBe(iso(at('2028-02-29', 10)));
    // 31/03 (terça) à noite → quarta 01/04.
    expect(iso(nextScheduleOpening(at('2026-03-31', 17), weekdays))).toBe(iso(at('2026-04-01', 10)));
  });

  it('as etapas seguintes de quem já foi contatado seguem o horário e os dias, mas não as datas', () => {
    const s: Schedule = { ...weekdays, startDate: '2026-03-01', endDate: '2026-03-13' };
    const follow = followUpSchedule(s);
    expect(follow).toMatchObject({ startDate: null, endDate: null, days: DEFAULT_DAYS });
    // Passou da data final: para um primeiro contato não há abertura; para um acompanhamento há (segunda seguinte).
    expect(nextScheduleOpening(at('2026-03-13', 17), s)).toBeNull();
    expect(iso(nextScheduleOpening(at('2026-03-13', 17), follow))).toBe(iso(at('2026-03-16', 10)));
  });

  it('scheduleOf lê a linha do banco (datas como Date local ou texto)', () => {
    const row = {
      window_start_min: 600,
      window_end_min: 960,
      days_of_week: [1, 2, 3, 4, 5],
      start_date: new Date(2026, 9, 1),
      end_date: new Date(2026, 9, 31),
    };
    expect(scheduleOf(row)).toEqual({
      startMin: 600,
      endMin: 960,
      days: [1, 2, 3, 4, 5],
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    });
    expect(scheduleOf({ ...row, end_date: null, start_date: '2026-10-01' })).toMatchObject({
      startDate: '2026-10-01',
      endDate: null,
    });
  });
});

describe('dias da semana: textos e normalização', () => {
  it('normalizeDays: ordena, tira repetidos e valores fora de 1 a 7', () => {
    expect(normalizeDays([5, 1, 1, 3, 9, 0, 2.5])).toEqual([1, 3, 5]);
    expect(normalizeDays([])).toEqual([]);
    expect([...ALL_DAYS]).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('formatDays: "Seg–Sex", "Todos os dias", listas', () => {
    expect(formatDays([1, 2, 3, 4, 5])).toBe('Seg–Sex');
    expect(formatDays([1, 2, 3, 4, 5, 6, 7])).toBe('Todos os dias');
    expect(formatDays([1, 3, 5])).toBe('Seg, Qua e Sex');
    expect(formatDays([6, 7])).toBe('Sáb e Dom');
    expect(formatDays([2])).toBe('Ter');
    expect(formatDays([2, 3, 4])).toBe('Ter–Qui');
    expect(formatDays([])).toBe('Nenhum dia');
  });
});

describe('filtros do público: normalização', () => {
  it('só fica guardado o que restringe de verdade', () => {
    expect(normalizeFilters(undefined)).toEqual({});
    expect(normalizeFilters({})).toEqual({});
    expect(normalizeFilters({ ddd: [], status: [], result: [], phoneType: [], calledBefore: 'any' })).toEqual(
      {},
    );
    expect(
      normalizeFilters({
        ddd: ['41', '41', ' 11 ', 'x', '1'],
        status: ['chamado', 'pendente'],
        calledBefore: 'never',
      }),
    ).toEqual({ ddd: ['11', '41'], status: ['pendente', 'chamado'], calledBefore: 'never' });
    expect(
      normalizeFilters({ result: ['respondeu', 'respondeu', 'fechou'], phoneType: ['fixo', 'movel'] }),
    ).toEqual({
      result: ['respondeu', 'fechou'],
      phoneType: ['movel', 'fixo'],
    });
  });
});

describe('validação da campanha: agenda, cooldown e filtros', () => {
  const list = '11111111-1111-4111-8111-111111111111';
  const base = { listId: list, instanceIds: [1, 2] };

  it('padrões: segunda a sexta, 24 h de cooldown, sem filtros, sem datas', () => {
    const parsed = campaignCreateSchema.parse(base);
    expect(parsed).toMatchObject({ daysOfWeek: [1, 2, 3, 4, 5], cooldownHours: 24, filters: {} });
    expect(parsed.startDate).toBeUndefined();
    expect(parsed.endDate).toBeUndefined();
  });

  it('datas: só datas que existem, e a final não pode ser antes da inicial', () => {
    expect(
      campaignCreateSchema.safeParse({ ...base, startDate: '2026-10-01', endDate: '2026-10-31' }).success,
    ).toBe(true);
    expect(
      campaignCreateSchema.safeParse({ ...base, startDate: '2026-10-01', endDate: '2026-10-01' }).success,
    ).toBe(true);
    for (const bad of [
      { startDate: '2026-02-30' },
      { startDate: '01/10/2026' },
      { endDate: '2026-13-01' },
      { startDate: '2026-10-05', endDate: '2026-10-01' },
    ]) {
      expect(campaignCreateSchema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(campaignCreateSchema.safeParse({ ...base, endDate: null }).success).toBe(true);
  });

  it('dias da semana: de 1 a 7, pelo menos um, sem repetir (são normalizados)', () => {
    expect(campaignCreateSchema.parse({ ...base, daysOfWeek: [5, 1, 1, 3] }).daysOfWeek).toEqual([1, 3, 5]);
    for (const bad of [[], [0], [8], [1.5], ['1']]) {
      expect(campaignCreateSchema.safeParse({ ...base, daysOfWeek: bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it('cooldown de 0 (sem cooldown) a 720 horas', () => {
    expect(campaignCreateSchema.parse({ ...base, cooldownHours: 0 }).cooldownHours).toBe(0);
    expect(campaignCreateSchema.parse({ ...base, cooldownHours: 720 }).cooldownHours).toBe(720);
    for (const bad of [-1, 721, 1.5, '24']) {
      expect(campaignCreateSchema.safeParse({ ...base, cooldownHours: bad }).success, String(bad)).toBe(
        false,
      );
    }
  });

  it('filtros: DDD com dois dígitos, situação e resultado que existem, filtro desconhecido é recusado', () => {
    const ok = campaignCreateSchema.parse({
      ...base,
      filters: {
        ddd: ['41', '41', '11'],
        status: ['pendente'],
        result: ['respondeu'],
        phoneType: ['movel'],
        calledBefore: 'never',
      },
    });
    expect(ok.filters).toEqual({
      ddd: ['11', '41'],
      status: ['pendente'],
      result: ['respondeu'],
      phoneType: ['movel'],
      calledBefore: 'never',
    });
    for (const bad of [
      { ddd: ['4'] },
      { ddd: ['abc'] },
      { status: ['bloqueado'] }, // bloqueado nunca é público de primeiro contato
      { result: ['inventado'] },
      { phoneType: ['satelite'] },
      { calledBefore: 'talvez' },
      { cor: 'azul' },
    ]) {
      expect(campaignCreateSchema.safeParse({ ...base, filters: bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
    // Filtro vazio ou "tanto faz" não fica guardado.
    expect(
      campaignCreateSchema.parse({ ...base, filters: { ddd: [], calledBefore: 'any' } }).filters,
    ).toEqual({});
  });

  it('alterar campanha: manda-se só o que muda, pelo menos um campo', () => {
    expect(campaignUpdateSchema.safeParse({}).success).toBe(false);
    expect(campaignUpdateSchema.parse({ cooldownHours: 12 })).toEqual({ cooldownHours: 12 });
    expect(campaignUpdateSchema.parse({ endDate: null })).toEqual({ endDate: null });
    expect(campaignUpdateSchema.safeParse({ windowStart: '16:00', windowEnd: '10:00' }).success).toBe(false);
    expect(campaignUpdateSchema.safeParse({ startDate: '2026-10-05', endDate: '2026-10-01' }).success).toBe(
      false,
    );
    expect(campaignUpdateSchema.parse({ filters: { ddd: ['41'] } })).toEqual({ filters: { ddd: ['41'] } });
  });
});

// ---------- capacidade, estimativa e calendário ----------

const number = (o: Partial<CapacityNumber> = {}): CapacityNumber => ({
  connected: true,
  remainingToday: 20,
  limit: 20,
  ...o,
});

describe('capacidade real', () => {
  it('1 número = 20 por dia; 2 = 40; 3 = 60', () => {
    expect(capacityPerDay([number()])).toBe(20);
    expect(capacityPerDay([number(), number()])).toBe(40);
    expect(capacityPerDay([number(), number(), number()])).toBe(60);
  });

  it('número desconectado não soma (e volta a somar quando reconecta)', () => {
    expect(capacityPerDay([number(), number({ connected: false }), number()])).toBe(40);
    expect(capacityPerDay([number(), number({ connected: true }), number()])).toBe(60);
  });

  it('capacidade de HOJE: só o que resta de cada número conectado (7/20 + 13/20 + 20/20 = 19)', () => {
    const numbers = [
      number({ remainingToday: 6 }), // 14/20
      number({ remainingToday: 13 }), // 7/20
      number({ remainingToday: 0 }), // 20/20
    ];
    expect(capacityToday(at('2026-03-10', 11), weekdays, numbers)).toBe(19);
    // Número cheio e número desconectado ficam fora.
    expect(
      capacityToday(at('2026-03-10', 11), weekdays, [
        ...numbers,
        number({ connected: false, remainingToday: 20 }),
      ]),
    ).toBe(19);
  });

  it('hoje não conta se não é dia da campanha ou se a janela de hoje já fechou', () => {
    const numbers = [number(), number()];
    expect(capacityToday(at('2026-03-14', 11), weekdays, numbers)).toBe(0); // sábado
    expect(capacityToday(at('2026-03-10', 16, 0), weekdays, numbers)).toBe(0); // janela fechou
    expect(capacityToday(at('2026-03-10', 7), weekdays, numbers)).toBe(40); // ainda vai abrir
  });
});

describe('calendário dos próximos dias', () => {
  it('quinta 01/10 a segunda 05/10: fim de semana não executa', () => {
    const s: Schedule = { ...weekdays, startDate: '2026-10-01' };
    const days = buildCalendar(at('2026-10-01', 7), s, [number(), number(), number()], 5);
    expect(days.map((d) => [d.date, d.weekday, d.state, d.capacity])).toEqual([
      ['2026-10-01', 4, 'runs', 60],
      ['2026-10-02', 5, 'runs', 60],
      ['2026-10-03', 6, 'not_allowed', 0],
      ['2026-10-04', 7, 'not_allowed', 0],
      ['2026-10-05', 1, 'runs', 60],
    ]);
  });

  it('hoje usa a cota que resta; os dias seguintes, o dia cheio', () => {
    const days = buildCalendar(
      at('2026-03-10', 11),
      weekdays,
      [number({ remainingToday: 5 }), number({ remainingToday: 0 })],
      3,
    );
    expect(days.map((d) => d.capacity)).toEqual([5, 40, 40]);
  });

  it('antes da data inicial, depois da final e janela de hoje já fechada', () => {
    const s: Schedule = { ...weekdays, startDate: '2026-03-11', endDate: '2026-03-12' };
    const days = buildCalendar(at('2026-03-10', 18), s, [number()], 4);
    expect(days.map((d) => d.state)).toEqual(['before_start', 'runs', 'runs', 'after_end']);
    const closed = buildCalendar(at('2026-03-10', 18), weekdays, [number()], 2);
    expect(closed.map((d) => [d.state, d.capacity])).toEqual([
      ['window_closed', 0],
      ['runs', 20],
    ]);
  });
});

describe('estimativa de duração (aproximada)', () => {
  const three = [number(), number(), number()];

  it('1.972 elegíveis com 60 por dia (segunda a sexta): 33 dias de execução', () => {
    const e = estimateDuration(at('2026-10-01', 7), { ...weekdays, startDate: '2026-10-01' }, three, 1972);
    expect(e).toMatchObject({
      status: 'ok',
      eligible: 1972,
      connectedNumbers: 3,
      capacityPerDay: 60,
      capacityToday: 60,
    });
    expect(e.runDays).toBe(33); // ceil(1972 / 60)
    expect(e.firstDay).toBe('2026-10-01');
    expect(e.lastDay).toBe('2026-11-16'); // 33 dias úteis depois de 01/10, pulando fins de semana
    expect(e.leftover).toBe(0);
  });

  it('desconta a cota de hoje (o primeiro dia rende menos)', () => {
    const partial = [
      number({ remainingToday: 6 }),
      number({ remainingToday: 13 }),
      number({ remainingToday: 0 }),
    ];
    const e = estimateDuration(at('2026-03-10', 11), weekdays, partial, 100);
    // Terça: 19; depois 60/dia (quarta 60 → 79; quinta: fecha os 100). Só conta dias em que a campanha executa.
    expect(e.capacityToday).toBe(19);
    expect(e.runDays).toBe(3);
    expect(e.lastDay).toBe('2026-03-12');
  });

  it('a data final corta: sobram leads', () => {
    const s: Schedule = { ...weekdays, startDate: '2026-10-01', endDate: '2026-10-02' };
    const e = estimateDuration(at('2026-10-01', 7), s, three, 500);
    expect(e).toMatchObject({ status: 'beyond_end_date', runDays: 2, leftover: 380 }); // 500 - 2 x 60
    expect(e.lastDay).toBe('2026-10-02');
  });

  it('sem público, sem número conectado ou sem dia possível', () => {
    expect(estimateDuration(at('2026-10-01', 7), weekdays, three, 0).status).toBe('no_audience');
    expect(estimateDuration(at('2026-10-01', 7), weekdays, [number({ connected: false })], 50)).toMatchObject(
      {
        status: 'no_capacity',
        leftover: 50,
      },
    );
    const never: Schedule = { ...weekdays, startDate: '2099-01-01' };
    expect(estimateDuration(at('2026-10-01', 7), never, three, 50).status).toBe('too_long');
    expect(MAX_ESTIMATE_DAYS).toBeGreaterThanOrEqual(365);
  });

  it('número cheio e desconectado não entram: 1 conectado com vaga rende só o dele', () => {
    const numbers = [
      number({ remainingToday: 0 }),
      number({ connected: false }),
      number({ remainingToday: 4 }),
    ];
    const e = estimateDuration(at('2026-03-10', 11), weekdays, numbers, 30);
    expect(e.capacityToday).toBe(4);
    expect(e.capacityPerDay).toBe(40); // os dois conectados, com o dia vazio
    expect(e.runDays).toBe(2); // hoje 4, amanhã 40 (só precisa de 26)
  });
});
