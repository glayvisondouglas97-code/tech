import { describe, expect, it } from 'vitest';
import { shuffled } from '../../src/server/lib/shuffle';
import { orderByUtilization } from '../../src/server/modules/automations/queue';
import {
  campaignCreateSchema,
  parseCampaignId,
  runsQuerySchema,
  stepCreateSchema,
} from '../../src/server/modules/automations/validation';
import {
  addDays,
  FIRST_OF_DAY_SPREAD_SECONDS,
  insideWindow,
  MAX_GAP_FACTOR,
  MIN_GAP_FACTOR,
  nextWindowOpening,
  planSlot,
  spDate,
  spInstant,
  spTime,
} from '../../src/server/modules/automations/window';
import {
  CAMPAIGN_DEFAULTS,
  CAMPAIGN_MAX_DAILY_LIMIT,
  CAMPAIGN_MAX_NUMBERS,
  campaignEndLabel,
  formatClock,
  parseClock,
  runReasonLabel,
  stepProblem,
} from '../../src/shared/automations';

// Regras puras das campanhas: horário de São Paulo, janela de trabalho, espaçamento dos envios, ordem dos números,
// validação do que o gestor envia e regras do áudio sorteado. Nada aqui usa banco nem relógio de verdade.

/** Um dia de teste em São Paulo (terça-feira). */
const DAY = '2026-03-10';
const at = (hh: number, mm = 0, ss = 0) => new Date(spInstant(DAY, hh * 60 + mm).getTime() + ss * 1000);

describe('horário de São Paulo', () => {
  it('converte um instante para a data e os minutos de São Paulo (UTC−3)', () => {
    expect(spTime(new Date('2026-03-10T13:00:00Z'))).toEqual({ date: DAY, minutes: 600, seconds: 0 });
    expect(spTime(new Date('2026-03-10T13:00:07Z')).seconds).toBe(7);
  });

  it('o dia vira à meia-noite de São Paulo, não à de UTC', () => {
    // 02:59Z ainda é 23:59 do dia 09 em São Paulo; 03:00Z já é 00:00 do dia 10.
    expect(spDate(new Date('2026-03-10T02:59:59Z'))).toBe('2026-03-09');
    expect(spDate(new Date('2026-03-10T03:00:00Z'))).toBe(DAY);
    // 23:30 em São Paulo ainda é o mesmo dia, mesmo já sendo o dia seguinte em UTC.
    expect(spDate(new Date('2026-03-11T02:30:00Z'))).toBe(DAY);
  });

  it('spInstant é o inverso: dia e minuto de São Paulo → instante', () => {
    expect(spInstant(DAY, 600).toISOString()).toBe('2026-03-10T13:00:00.000Z');
    expect(spInstant(DAY, 0).toISOString()).toBe('2026-03-10T03:00:00.000Z');
    expect(spInstant(DAY, 1440).toISOString()).toBe('2026-03-11T03:00:00.000Z');
    for (const minutes of [0, 1, 599, 600, 960, 1439]) {
      expect(spTime(spInstant(DAY, minutes)).minutes).toBe(minutes);
      expect(spDate(spInstant(DAY, minutes))).toBe(DAY);
    }
  });

  it('addDays atravessa fim de mês e de ano', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays(DAY, -10)).toBe('2026-02-28');
  });

  it('interpreta e escreve horários HH:MM', () => {
    expect(parseClock('10:00')).toBe(600);
    expect(parseClock('9:05')).toBe(545);
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('24:00')).toBe(1440);
    for (const bad of ['', '25:00', '10:60', '24:01', '10', '10h', 'ab:cd', '-1:00', '10:5']) {
      expect(parseClock(bad), bad).toBeNull();
    }
    expect(formatClock(600)).toBe('10:00');
    expect(formatClock(545)).toBe('09:05');
    expect(formatClock(1440)).toBe('24:00');
  });
});

describe('janela de trabalho (10:00 às 16:00 por padrão)', () => {
  const [open, close] = [600, 960];

  it('o início entra e o fim não entra: [10:00, 16:00)', () => {
    expect(insideWindow(at(9, 59, 59), open, close)).toBe(false);
    expect(insideWindow(at(10, 0, 0), open, close)).toBe(true);
    expect(insideWindow(at(15, 59, 59), open, close)).toBe(true);
    expect(insideWindow(at(16, 0, 0), open, close)).toBe(false);
    expect(insideWindow(at(23, 59), open, close)).toBe(false);
    expect(insideWindow(at(0, 0), open, close)).toBe(false);
  });

  it('nextWindowOpening: dentro = o próprio instante; antes = hoje; depois = amanhã', () => {
    const inside = at(12, 30);
    expect(nextWindowOpening(inside, open, close)).toBe(inside);
    expect(nextWindowOpening(at(8, 15), open, close).toISOString()).toBe(at(10).toISOString());
    expect(nextWindowOpening(at(16, 0), open, close).toISOString()).toBe(
      spInstant(addDays(DAY, 1), open).toISOString(),
    );
    expect(nextWindowOpening(at(23, 59), open, close).toISOString()).toBe(
      spInstant(addDays(DAY, 1), open).toISOString(),
    );
  });

  it('respeita uma janela diferente da padrão', () => {
    expect(insideWindow(at(13, 0), 780, 840)).toBe(true);
    expect(insideWindow(at(14, 0), 780, 840)).toBe(false);
    expect(nextWindowOpening(at(15), 780, 840).toISOString()).toBe(
      spInstant(addDays(DAY, 1), 780).toISOString(),
    );
  });
});

describe('planSlot: espalha os envios pela janela', () => {
  const base = { startMin: 600, endMin: 960, limit: 20 };
  /** Sequência fixa de "sorteios" para os testes ficarem reprodutíveis sem depender do Math.random de verdade. */
  const fakeRandom = (...values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length] as number;
  };

  it('o primeiro do dia sai perto da abertura da janela, com variação sorteada', () => {
    const noSpread = planSlot(at(8, 0), { ...base, used: 0, random: fakeRandom(0) }) as Date;
    expect(noSpread.getTime()).toBe(at(10).getTime());
    const maxSpread = planSlot(at(8, 0), { ...base, used: 0, random: fakeRandom(1) }) as Date;
    expect(maxSpread.getTime() - at(10).getTime()).toBe(FIRST_OF_DAY_SPREAD_SECONDS * 1000);
  });

  it('agendando com a janela já aberta, sai a partir de agora', () => {
    const now = at(11, 0);
    const slot = planSlot(now, { ...base, used: 0, random: fakeRandom(0.4) }) as Date;
    expect(slot.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(slot.getTime() - now.getTime()).toBeLessThan(FIRST_OF_DAY_SPREAD_SECONDS * 1000);
  });

  it('o fator de variação vai de MIN_GAP_FACTOR a MAX_GAP_FACTOR em torno da média', () => {
    const now = at(11);
    const used = 3;
    const remaining = base.limit - used;
    const meanGap = (at(16).getTime() - now.getTime()) / (remaining + 1);
    const min = planSlot(now, { ...base, used, random: fakeRandom(0) }) as Date;
    const max = planSlot(now, { ...base, used, random: fakeRandom(0.999999) }) as Date;
    expect(min.getTime() - now.getTime()).toBeCloseTo(meanGap * MIN_GAP_FACTOR, -2);
    expect(max.getTime() - now.getTime()).toBeCloseTo(meanGap * MAX_GAP_FACTOR, -2);
    expect(max.getTime()).toBeGreaterThan(min.getTime());
  });

  it('sem "random" fixo (o caso de produção), cada chamada tende a sortear um intervalo diferente', () => {
    const now = at(11);
    const one = planSlot(now, { ...base, used: 3 }) as Date;
    const two = planSlot(now, { ...base, used: 3 }) as Date;
    // Math.random de verdade: praticamente impossível cair no mesmo milissegundo duas vezes.
    expect(one.getTime()).not.toBe(two.getTime());
  });

  it('20 vagas em 6 horas: nunca o mesmo intervalo duas vezes, sempre dentro da janela e em ordem crescente', () => {
    let now = at(10);
    let previous = 0;
    const gaps: number[] = [];
    // Sequência determinística que passeia entre os extremos do sorteio, para o teste ser reprodutível.
    const draws = [0.05, 0.9, 0.2, 0.75, 0.5, 0.95, 0.1, 0.6, 0.3, 0.85];
    for (let used = 0; used < 20; used++) {
      const slot = planSlot(now, {
        ...base,
        used,
        random: fakeRandom(draws[used % draws.length] as number),
      }) as Date;
      expect(slot, `vaga ${used + 1}`).not.toBeNull();
      expect(slot.getTime(), `vaga ${used + 1} depois da anterior`).toBeGreaterThanOrEqual(previous);
      expect(insideWindow(slot, 600, 960), `vaga ${used + 1} dentro da janela`).toBe(true);
      if (used > 0) gaps.push((slot.getTime() - previous) / 60_000);
      previous = slot.getTime();
      now = slot; // o envio acontece no horário marcado; a próxima reserva parte dali
    }
    // A última sai antes do fim da janela (não no último segundo).
    expect(previous).toBeLessThan(at(16).getTime());
    // O espaçamento varia de verdade: o maior intervalo é bem mais que o dobro do menor.
    expect(Math.max(...gaps)).toBeGreaterThan(Math.min(...gaps) * 2);
  });

  it('a janela de hoje fechou ou o número não tem mais vaga: não agenda (null)', () => {
    expect(planSlot(at(16, 0), { ...base, used: 0 })).toBeNull();
    expect(planSlot(at(20, 0), { ...base, used: 0 })).toBeNull();
    expect(planSlot(at(11, 0), { ...base, used: 20 })).toBeNull();
    expect(planSlot(at(11, 0), { ...base, used: 25 })).toBeNull();
  });

  it('a última vaga nunca passa do fim da janela, mesmo agendada em cima da hora', () => {
    const slot = planSlot(at(15, 59, 30), { ...base, used: 19, random: fakeRandom(0.999999) }) as Date;
    expect(slot.getTime()).toBeLessThan(at(16).getTime());
  });

  it('usa a janela recebida (13:00 às 14:00)', () => {
    const slot = planSlot(at(8), {
      startMin: 780,
      endMin: 840,
      limit: 5,
      used: 0,
      random: fakeRandom(0),
    }) as Date;
    expect(slot.toISOString()).toBe(at(13).toISOString());
    expect(planSlot(at(14), { startMin: 780, endMin: 840, limit: 5, used: 0 })).toBeNull();
  });
});

describe('orderByUtilization: qual número recebe o próximo lead', () => {
  const identity = (ids: readonly number[]) => [...ids];

  it('o menos usado (uso do dia / limite) vai primeiro', () => {
    const usage = new Map([
      [1, 15],
      [2, 3],
      [3, 9],
    ]);
    expect(orderByUtilization([1, 2, 3], usage, 20, identity)).toEqual([2, 3, 1]);
  });

  it('número sem nenhum uso hoje conta como zero', () => {
    expect(orderByUtilization([1, 2], new Map([[1, 4]]), 20, identity)).toEqual([2, 1]);
  });

  it('empate se resolve pelo embaralhamento, e nenhum número fica sempre na frente', () => {
    const usage = new Map([
      [1, 5],
      [2, 5],
      [3, 5],
    ]);
    const firsts = new Set<number>();
    for (let i = 0; i < 200; i++) firsts.add(orderByUtilization([1, 2, 3], usage, 20)[0] as number);
    expect([...firsts].sort()).toEqual([1, 2, 3]);
  });

  it('o empate só decide entre iguais: o menos usado continua na frente, seja qual for o sorteio', () => {
    const usage = new Map([
      [1, 10],
      [2, 2],
      [3, 2],
    ]);
    for (let i = 0; i < 100; i++) {
      const order = orderByUtilization([1, 2, 3], usage, 20);
      expect(order[2]).toBe(1);
      expect(order.slice(0, 2).sort()).toEqual([2, 3]);
    }
  });

  it('não altera a lista original e devolve todos os números', () => {
    const ids = [3, 1, 2];
    const order = orderByUtilization(ids, new Map(), 20);
    expect(ids).toEqual([3, 1, 2]);
    expect([...order].sort()).toEqual([1, 2, 3]);
  });
});

describe('shuffled: embaralhar sem mexer na lista', () => {
  it('mantém os mesmos itens e não altera a entrada', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffled(input);
    expect([...out].sort()).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('todas as posições aparecem (não é sempre a mesma ordem)', () => {
    const firsts = new Set<number>();
    for (let i = 0; i < 300; i++) firsts.add(shuffled([1, 2, 3])[0] as number);
    expect(firsts.size).toBe(3);
  });
});

describe('validação: iniciar campanha', () => {
  const list = '11111111-1111-4111-8111-111111111111';
  const ok = { listId: list, instanceIds: [1, 2] };

  it('usa os padrões: 10:00 às 16:00 e 20 leads novos por número por dia', () => {
    const parsed = campaignCreateSchema.parse(ok);
    expect(parsed).toEqual({
      listId: list,
      instanceIds: [1, 2],
      windowStart: '10:00',
      windowEnd: '16:00',
      dailyLimitPerNumber: 20,
      // Fase 6: segunda a sexta, 24 h de cooldown e sem filtros (a data inicial vazia significa "hoje").
      daysOfWeek: [1, 2, 3, 4, 5],
      cooldownHours: 24,
      filters: {},
    });
    expect(CAMPAIGN_DEFAULTS).toEqual({ windowStart: '10:00', windowEnd: '16:00', dailyLimitPerNumber: 20 });
  });

  it('aceita horário e limite escolhidos', () => {
    const parsed = campaignCreateSchema.parse({
      ...ok,
      windowStart: '08:30',
      windowEnd: '24:00',
      dailyLimitPerNumber: 15,
    });
    expect(parsed).toMatchObject({ windowStart: '08:30', windowEnd: '24:00', dailyLimitPerNumber: 15 });
  });

  it('recusa lista inválida, números vazios, repetidos ou demais', () => {
    expect(campaignCreateSchema.safeParse({ ...ok, listId: 'nao-e-uuid' }).success).toBe(false);
    expect(campaignCreateSchema.safeParse({ listId: list }).success).toBe(false);
    expect(campaignCreateSchema.safeParse({ ...ok, instanceIds: [] }).success).toBe(false);
    expect(campaignCreateSchema.safeParse({ ...ok, instanceIds: [1, 1] }).success).toBe(false);
    expect(campaignCreateSchema.safeParse({ ...ok, instanceIds: [0] }).success).toBe(false);
    expect(campaignCreateSchema.safeParse({ ...ok, instanceIds: [1.5] }).success).toBe(false);
    const many = Array.from({ length: CAMPAIGN_MAX_NUMBERS + 1 }, (_, i) => i + 1);
    expect(campaignCreateSchema.safeParse({ ...ok, instanceIds: many }).success).toBe(false);
    expect(
      campaignCreateSchema.safeParse({ ...ok, instanceIds: many.slice(0, CAMPAIGN_MAX_NUMBERS) }).success,
    ).toBe(true);
  });

  it('recusa horário inválido, fim antes do início ou janela vazia', () => {
    for (const body of [
      { windowStart: '25:00' },
      { windowEnd: 'meio-dia' },
      { windowStart: '16:00', windowEnd: '10:00' },
      { windowStart: '10:00', windowEnd: '10:00' },
      { windowStart: '24:00', windowEnd: '24:00' },
    ]) {
      expect(campaignCreateSchema.safeParse({ ...ok, ...body }).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('o limite por número vai de 1 a 20 (inteiro): nenhum número faz mais de 20 contatos por dia', () => {
    for (const limit of [0, -1, 1.5, CAMPAIGN_MAX_DAILY_LIMIT + 1, '20']) {
      expect(
        campaignCreateSchema.safeParse({ ...ok, dailyLimitPerNumber: limit }).success,
        String(limit),
      ).toBe(false);
    }
    expect(campaignCreateSchema.safeParse({ ...ok, dailyLimitPerNumber: 1 }).success).toBe(true);
    expect(
      campaignCreateSchema.safeParse({ ...ok, dailyLimitPerNumber: CAMPAIGN_MAX_DAILY_LIMIT }).success,
    ).toBe(true);
  });

  it('id de campanha inválido responde 404 (como os outros ids)', () => {
    expect(parseCampaignId('12')).toBe(12);
    for (const bad of ['abc', '0', '-3', '1.5', '']) {
      expect(() => parseCampaignId(bad), bad).toThrow(/não encontrada/i);
    }
  });

  it('a lista de execuções aceita filtrar por campanha', () => {
    expect(runsQuerySchema.parse({ campaignId: '9' })).toEqual({ limit: 30, campaignId: 9 });
    expect(runsQuerySchema.parse({}).campaignId).toBeUndefined();
    expect(runsQuerySchema.safeParse({ campaignId: '0' }).success).toBe(false);
  });
});

describe('áudio sorteado na etapa', () => {
  it('a etapa de áudio sorteado não precisa de áudio fixo; a fixa continua precisando', () => {
    expect(
      stepProblem({ actionType: 'send_audio', messageText: null, audioId: null, audioMode: 'random' }),
    ).toBeNull();
    expect(
      stepProblem({ actionType: 'send_audio', messageText: null, audioId: null, audioMode: 'fixed' }),
    ).toMatch(/áudio/);
    expect(stepProblem({ actionType: 'send_audio', messageText: null, audioId: null })).toMatch(/áudio/);
    expect(
      stepProblem({ actionType: 'send_audio', messageText: null, audioId: 3, audioMode: 'fixed' }),
    ).toBeNull();
  });

  it('a etapa de texto continua exigindo a mensagem, seja qual for o modo', () => {
    expect(
      stepProblem({ actionType: 'send_text', messageText: '  ', audioId: null, audioMode: 'random' }),
    ).toMatch(/mensagem/);
  });

  it('criar etapa de áudio sorteado: sem áudio fixo, e o áudio fixo é descartado no modo sorteio', () => {
    const random = stepCreateSchema.parse({
      actionType: 'send_audio',
      delaySeconds: 0,
      audioMode: 'random',
      conditions: [],
    });
    expect(random).toMatchObject({ audioMode: 'random', audioId: null, messageText: null });
    const ignoresFixed = stepCreateSchema.parse({
      actionType: 'send_audio',
      delaySeconds: 0,
      audioMode: 'random',
      audioId: 5,
      conditions: [],
    });
    expect(ignoresFixed.audioId).toBeNull();
    const fixed = stepCreateSchema.parse({
      actionType: 'send_audio',
      delaySeconds: 0,
      audioId: 5,
      conditions: [],
    });
    expect(fixed).toMatchObject({ audioMode: 'fixed', audioId: 5 });
    expect(
      stepCreateSchema.safeParse({ actionType: 'send_audio', delaySeconds: 0, conditions: [] }).success,
    ).toBe(false);
  });

  it('só a etapa de áudio sorteia: numa etapa de texto o modo é sempre "fixed"', () => {
    const text = stepCreateSchema.parse({
      actionType: 'send_text',
      delaySeconds: 0,
      messageText: 'Oi',
      audioMode: 'random',
      conditions: [],
    });
    expect(text.audioMode).toBe('fixed');
  });
});

describe('textos das campanhas', () => {
  it('cada motivo de encerramento e de cancelamento tem texto em português', () => {
    for (const reason of [
      'encerrada_manualmente',
      'lista_esgotada',
      'lista_removida',
      'lista_arquivada',
      'automacao_arquivada',
    ]) {
      expect(campaignEndLabel(reason), reason).toMatch(/[a-zà-ú]/i);
      expect(campaignEndLabel(reason)).not.toBe(reason);
    }
    expect(campaignEndLabel(null)).toBeNull();
    for (const reason of [
      'campanha_encerrada',
      'lista_removida',
      'lista_arquivada',
      'lead_indisponivel',
      'sem_whatsapp',
    ]) {
      expect(runReasonLabel(reason), reason).not.toBe(reason);
    }
  });
});
