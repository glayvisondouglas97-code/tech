import { describe, expect, it } from 'vitest';
import { orderByUtilization } from '../../src/server/modules/automations/queue';
import { insideWindow, spInstant } from '../../src/server/modules/automations/window';
import { EvolutionError } from '../../src/server/modules/whatsapp/evolution';
import {
  effectiveLimit,
  poolWithCapacity,
  quotaDate,
  sendDefinitelyFailed,
} from '../../src/server/modules/whatsapp/quota';
import { CAMPAIGN_MAX_DAILY_LIMIT } from '../../src/shared/automations';
import { contactLimitMessage, INSTANCE_DAILY_CONTACT_LIMIT, usageOf } from '../../src/shared/quota';

// A regra da cota diária de contatos por número (20, manual + automático, dia de São Paulo), sem banco nem relógio de
// verdade. A prova de concorrência e de persistência está em tests/integration/whatsapp-quota.test.ts.

const DAY = '2026-09-25';
const at = (hh: number, mm = 0, day = DAY) => spInstant(day, hh * 60 + mm);
const usage = (manual: number, automatic: number, uncertain = 0) =>
  usageOf({ manual, automatic, uncertain }, DAY);

describe('cota diária: 20 contatos por número por dia', () => {
  it('o limite oficial é 20, e o teto de uma campanha nunca passa dele', () => {
    expect(INSTANCE_DAILY_CONTACT_LIMIT).toBe(20);
    expect(CAMPAIGN_MAX_DAILY_LIMIT).toBe(20);
    expect(effectiveLimit()).toBe(20);
    expect(effectiveLimit(500)).toBe(20);
    expect(effectiveLimit(7)).toBe(7);
    expect(effectiveLimit(0)).toBe(1);
    expect(effectiveLimit(null)).toBe(20);
  });

  it('0/20: permitido, com as 20 vagas livres', () => {
    const u = usage(0, 0);
    expect(u).toMatchObject({ total: 0, limit: 20, remaining: 20, limitReached: false });
  });

  it('19/20: ainda cabe UM contato; 20/20: recusado', () => {
    expect(usage(0, 19)).toMatchObject({ total: 19, remaining: 1, limitReached: false });
    expect(usage(0, 20)).toMatchObject({ total: 20, remaining: 0, limitReached: true });
    expect(usage(20, 0)).toMatchObject({ total: 20, remaining: 0, limitReached: true });
  });

  it('manual + automático + incerto SOMAM (não são cotas separadas): 7 + 13 = 20, nunca 40', () => {
    expect(usage(7, 13)).toMatchObject({ manual: 7, automatic: 13, total: 20, limitReached: true });
    expect(usage(4, 16)).toMatchObject({ total: 20, limitReached: true });
    expect(usage(20, 0)).toMatchObject({ total: 20, limitReached: true });
    // O envio de resultado incerto também ocupa a vaga (política conservadora).
    expect(usage(6, 9, 1)).toMatchObject({ total: 16, remaining: 4 });
    expect(usage(10, 9, 1)).toMatchObject({ total: 20, limitReached: true });
  });

  it('um teto menor da campanha vale para o total do número (manual incluído)', () => {
    const u = usageOf({ manual: 4, automatic: 1, uncertain: 0 }, DAY, 5);
    expect(u).toMatchObject({ total: 5, limit: 5, remaining: 0, limitReached: true });
    expect(usageOf({ manual: 4, automatic: 0, uncertain: 0 }, DAY, 5)).toMatchObject({
      remaining: 1,
      limitReached: false,
    });
  });

  it('a mensagem para quem tenta passar do limite é legível', () => {
    expect(contactLimitMessage()).toBe('Este número já atingiu o limite de 20 contatos hoje.');
  });
});

describe('cota diária: o dia é o de São Paulo', () => {
  it('a cota vira à meia-noite de São Paulo, não à de UTC', () => {
    expect(quotaDate(new Date('2026-09-26T02:59:59Z'))).toBe('2026-09-25');
    expect(quotaDate(new Date('2026-09-26T03:00:00Z'))).toBe('2026-09-26');
    expect(quotaDate(at(23, 59))).toBe(DAY);
  });

  it('RESERVA não é USO: o lead reservado às 15:59 e enviado no dia seguinte consome a cota do dia seguinte', () => {
    const reservedAt = at(15, 59);
    const sentAt = at(10, 0, '2026-09-26');
    expect(quotaDate(reservedAt)).toBe('2026-09-25');
    // A cota é a do instante do ENVIO, nunca a do instante da reserva.
    expect(quotaDate(sentAt)).toBe('2026-09-26');
    expect(quotaDate(sentAt)).not.toBe(quotaDate(reservedAt));
  });

  it('novo dia, novo uso: o mesmo número volta a 0/20 sem ninguém zerar nada', () => {
    const yesterday = usage(7, 13);
    const today = usageOf(null, '2026-09-26');
    expect(yesterday.limitReached).toBe(true);
    expect(today).toMatchObject({ date: '2026-09-26', total: 0, remaining: 20, limitReached: false });
  });
});

describe('cota diária e horário de trabalho são regras independentes', () => {
  const canSend = (now: Date, u: ReturnType<typeof usageOf>) =>
    insideWindow(now, 600, 960) && !u.limitReached;

  it('só envia com as DUAS: dentro do horário E com vaga', () => {
    expect(canSend(at(12), usage(3, 4))).toBe(true);
    expect(canSend(at(12), usage(10, 10))).toBe(false); // horário ok, cota cheia
    expect(canSend(at(9, 59), usage(0, 0))).toBe(false); // cota livre, antes do horário
    expect(canSend(at(16, 0), usage(0, 0))).toBe(false); // cota livre, janela fechou
    expect(canSend(at(16, 0), usage(10, 10))).toBe(false);
  });
});

describe('cota diária: o rodízio de números considera a capacidade que resta', () => {
  const totals = (m: Record<number, number>) =>
    new Map(Object.entries(m).map(([id, n]) => [Number(id), n] as const));
  const asUsage = (m: Record<number, number>) =>
    new Map(Object.entries(m).map(([id, n]) => [Number(id), { total: n }] as const));

  it('número cheio sai do pool; o parcialmente usado continua', () => {
    const u = asUsage({ 1: 20, 2: 11, 3: 4 });
    expect(poolWithCapacity([1, 2, 3], u)).toEqual([2, 3]);
    expect(poolWithCapacity([1, 2, 3], asUsage({ 1: 19, 2: 0, 3: 20 }))).toEqual([1, 2]);
    // Número sem nenhum uso hoje (sem linha) continua no pool.
    expect(poolWithCapacity([1, 2], asUsage({ 1: 20 }))).toEqual([2]);
    // Com o teto menor da campanha, 5 contatos já enchem o número.
    expect(poolWithCapacity([1, 2], asUsage({ 1: 5, 2: 4 }), 5)).toEqual([2]);
  });

  it('12/20, 7/20 e 18/20: o mais vazio vai primeiro, o mais cheio por último', () => {
    const order = orderByUtilization(
      poolWithCapacity([1, 2, 3], asUsage({ 1: 12, 2: 7, 3: 18 })),
      totals({ 1: 12, 2: 7, 3: 18 }),
      20,
      (ids) => [...ids],
    );
    expect(order).toEqual([2, 1, 3]);
  });

  it('não escolhe às cegas um número perto da cota enquanto outro está quase vazio', () => {
    for (let i = 0; i < 100; i++) {
      const order = orderByUtilization([1, 2, 3], totals({ 1: 18, 2: 3, 3: 10 }), 20);
      expect(order).toEqual([2, 3, 1]);
    }
  });

  it('empate de uso continua sendo decidido por sorteio (o princípio já existente)', () => {
    const firsts = new Set<number>();
    for (let i = 0; i < 200; i++)
      firsts.add(orderByUtilization([1, 2], totals({ 1: 9, 2: 9 }), 20)[0] as number);
    expect(firsts).toEqual(new Set([1, 2]));
  });
});

describe('cota diária: quando a vaga pode voltar', () => {
  it('só a recusa clara da Evolution (4xx) prova que a mensagem NÃO saiu', () => {
    expect(
      sendDefinitelyFailed(new EvolutionError(400, 'Connection Closed', 'POST /message/sendText/x')),
    ).toBe(true);
    expect(sendDefinitelyFailed(new EvolutionError(404, 'not found', 'POST /message/sendText/x'))).toBe(true);
    expect(sendDefinitelyFailed(new EvolutionError(499, 'x', 'POST /y'))).toBe(true);
  });

  it('erro do servidor, demora ou queda deixam a dúvida: a vaga fica ocupada', () => {
    expect(sendDefinitelyFailed(new EvolutionError(500, 'Internal error', 'POST /message/sendText/x'))).toBe(
      false,
    );
    expect(sendDefinitelyFailed(new EvolutionError(502, 'Bad gateway', 'POST /y'))).toBe(false);
    expect(sendDefinitelyFailed(new EvolutionError(300, 'x', 'POST /y'))).toBe(false);
    expect(sendDefinitelyFailed(new Error('The operation was aborted due to timeout'))).toBe(false);
    expect(sendDefinitelyFailed(new TypeError('fetch failed'))).toBe(false);
    expect(sendDefinitelyFailed(null)).toBe(false);
    expect(sendDefinitelyFailed('erro')).toBe(false);
  });
});
