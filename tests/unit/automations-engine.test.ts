import { describe, expect, it } from 'vitest';
import {
  conditionHolds,
  evaluateConditions,
  type LeadFacts,
} from '../../src/server/modules/automations/conditions';
import { FALLBACKS, type RenderData, renderMessage } from '../../src/server/modules/automations/renderer';
import {
  BATCH_SIZE,
  CYCLE_SECONDS,
  isDue,
  MAX_ATTEMPTS,
  RETRY_SECONDS,
  STUCK_AFTER_MINUTES,
  scheduleAfter,
} from '../../src/server/modules/automations/schedule';
import type { AutomationCondition } from '../../src/shared/api';
import { automationProblems, runReasonLabel } from '../../src/shared/automations';

const data: RenderData = {
  name: 'João',
  company: 'Empresa XYZ',
  phone: '(41) 99876-5432',
  attendant: 'Ana',
  number: '(11) 90000-0000',
};

describe('renderer: variáveis da mensagem', () => {
  it('troca cada variável pelos dados reais', () => {
    expect(renderMessage('Olá, {{nome}}!', data).text).toBe('Olá, João!');
    expect(renderMessage('Da {{empresa}}', data).text).toBe('Da Empresa XYZ');
    expect(renderMessage('Seu telefone: {{telefone}}', data).text).toBe('Seu telefone: (41) 99876-5432');
    expect(renderMessage('Aqui é {{atendente}}', data).text).toBe('Aqui é Ana');
    expect(renderMessage('Pelo número {{numero}}', data).text).toBe('Pelo número (11) 90000-0000');
  });

  it('troca várias variáveis de uma vez, inclusive repetidas, e aceita espaços dentro das chaves', () => {
    const r = renderMessage(
      'Olá, {{nome}}! Aqui é {{ atendente }} da {{empresa}}. {{nome}}, tudo bem?',
      data,
    );
    expect(r.text).toBe('Olá, João! Aqui é Ana da Empresa XYZ. João, tudo bem?');
    expect(r.unknown).toEqual([]);
  });

  it('mensagem sem variáveis sai igual', () => {
    const text = 'Bom dia! Tudo bem? Posso ajudar {sozinho} com chaves simples?';
    expect(renderMessage(text, data)).toEqual({ text, unknown: [] });
  });

  it('NÃO troca em silêncio uma variável que não existe: devolve na lista e mantém o texto', () => {
    const r = renderMessage('Oi {{nomee}} e {{nome}} e {{nomee}} e {{outra}}', data);
    expect(r.unknown).toEqual(['nomee', 'outra']);
    expect(r.text).toBe('Oi {{nomee}} e João e {{nomee}} e {{outra}}');
  });

  it('dado vazio do lead cai num texto coerente, nunca num buraco', () => {
    const empty: RenderData = { ...data, name: '  ', company: null, attendant: null };
    expect(renderMessage('{{nome}}|{{empresa}}|{{atendente}}', empty).text).toBe(
      `${FALLBACKS.nome}|${FALLBACKS.empresa}|${FALLBACKS.atendente}`,
    );
    // Sem nome, mas com empresa: usa a empresa.
    expect(renderMessage('{{nome}}', { ...data, name: null }).text).toBe('Empresa XYZ');
  });

  it('o que foi inserido não é interpretado de novo (sem injeção de variável)', () => {
    const tricky: RenderData = { ...data, name: '{{empresa}}' };
    expect(renderMessage('Oi {{nome}}', tricky).text).toBe('Oi {{empresa}}');
  });
});

describe('conditions: interpretação das condições da etapa', () => {
  const facts: LeadFacts = { result: 'interessado', replied: false, status: 'chamado', listId: 'lista-1' };
  const c = (
    field: AutomationCondition['field'],
    operator: 'is' | 'is_not',
    value: unknown,
  ): AutomationCondition => ({ field, operator, value }) as AutomationCondition;

  it('sem condições, a etapa vale', () => {
    expect(evaluateConditions([], facts)).toEqual({ passed: true, failed: null });
  });

  it('is: verdadeira e falsa, para os quatro campos', () => {
    expect(conditionHolds(c('lead_result', 'is', 'interessado'), facts)).toBe(true);
    expect(conditionHolds(c('lead_result', 'is', 'fechou'), facts)).toBe(false);
    expect(conditionHolds(c('lead_replied', 'is', false), facts)).toBe(true);
    expect(conditionHolds(c('lead_replied', 'is', true), facts)).toBe(false);
    expect(conditionHolds(c('lead_status', 'is', 'chamado'), facts)).toBe(true);
    expect(conditionHolds(c('lead_status', 'is', 'pendente'), facts)).toBe(false);
    expect(conditionHolds(c('lead_list', 'is', 'lista-1'), facts)).toBe(true);
    expect(conditionHolds(c('lead_list', 'is', 'lista-2'), facts)).toBe(false);
  });

  it('is_not: o contrário, inclusive quando o lead ainda não tem resultado', () => {
    expect(conditionHolds(c('lead_result', 'is_not', 'fechou'), facts)).toBe(true);
    expect(conditionHolds(c('lead_result', 'is_not', 'interessado'), facts)).toBe(false);
    expect(conditionHolds(c('lead_result', 'is_not', 'respondeu'), { ...facts, result: null })).toBe(true);
    expect(conditionHolds(c('lead_replied', 'is_not', true), facts)).toBe(true);
  });

  it('várias condições: todas precisam valer (E), e diz qual falhou', () => {
    const ok = [c('lead_result', 'is', 'interessado'), c('lead_status', 'is', 'chamado')];
    expect(evaluateConditions(ok, facts).passed).toBe(true);
    const bad = [c('lead_result', 'is', 'interessado'), c('lead_status', 'is', 'pendente')];
    const result = evaluateConditions(bad, facts);
    expect(result.passed).toBe(false);
    expect(result.failed).toBe('Situação do lead é Pendente (na fila)');
  });

  it('a explicação usa o nome da lista quando se sabe', () => {
    const result = evaluateConditions([c('lead_list', 'is', 'lista-2')], facts, (id) =>
      id === 'lista-2' ? 'Clientes de setembro' : undefined,
    );
    expect(result.failed).toBe('Lista do lead é Clientes de setembro');
  });

  it('condição que não dá para entender conta como NÃO atendida (na dúvida, não envia)', () => {
    expect(conditionHolds({ type: 'lead_not_replied' } as unknown as AutomationCondition, facts)).toBe(false);
    expect(conditionHolds(c('lead_owner' as never, 'is', 'x'), facts)).toBe(false);
    expect(conditionHolds(c('lead_result', 'contains' as never, 'interessado'), facts)).toBe(false);
  });
});

describe('agenda: quando cada etapa deve agir', () => {
  const base = new Date('2026-09-26T10:00:00.000Z');

  it('espera 0 = imediatamente (o próprio instante)', () => {
    expect(scheduleAfter(base, 0).getTime()).toBe(base.getTime());
    expect(isDue(scheduleAfter(base, 0), base)).toBe(true);
  });

  it('segundos, minutos, horas e dias somam a partir da base', () => {
    expect(scheduleAfter(base, 30).toISOString()).toBe('2026-09-26T10:00:30.000Z');
    expect(scheduleAfter(base, 15 * 60).toISOString()).toBe('2026-09-26T10:15:00.000Z');
    expect(scheduleAfter(base, 2 * 3600).toISOString()).toBe('2026-09-26T12:00:00.000Z');
    expect(scheduleAfter(base, 86_400).toISOString()).toBe('2026-09-27T10:00:00.000Z');
  });

  it('a próxima etapa conta a espera dela a partir de quando a anterior terminou', () => {
    const firstDone = scheduleAfter(base, 0); // etapa 1 (imediata) enviada às 10:00
    const second = scheduleAfter(firstDone, 2 * 3600); // etapa 2: 2 horas depois
    const secondDone = new Date(second.getTime() + 5_000); // enviada 5 s atrasada
    expect(scheduleAfter(secondDone, 86_400).toISOString()).toBe('2026-09-27T12:00:05.000Z');
  });

  it('nunca agenda para trás e só vence quando chega a hora', () => {
    expect(scheduleAfter(base, -50).getTime()).toBe(base.getTime());
    const at = scheduleAfter(base, 60);
    expect(isDue(at, new Date(base.getTime() + 59_000))).toBe(false);
    expect(isDue(at, new Date(base.getTime() + 60_000))).toBe(true);
    expect(isDue(null, base)).toBe(false);
  });

  it('os limites do executor são conservadores', () => {
    expect(BATCH_SIZE).toBeGreaterThan(0);
    expect(BATCH_SIZE).toBeLessThanOrEqual(20);
    expect(CYCLE_SECONDS).toBeGreaterThanOrEqual(5);
    expect(RETRY_SECONDS).toBeGreaterThanOrEqual(60); // sem laço rápido de tentativas
    expect(MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(5);
    expect(STUCK_AFTER_MINUTES * 60).toBeGreaterThan(60); // acima do limite de 60 s de um envio
  });
});

describe('regras: quando uma automação não pode executar', () => {
  it('sem etapa não há o que executar (nem ativar)', () => {
    expect(automationProblems([])).toEqual(['Adicione pelo menos uma etapa.']);
  });

  it('etapa incompleta impede: texto vazio e áudio sem escolher', () => {
    const problems = automationProblems([
      { position: 1, actionType: 'send_text', messageText: '', audioId: null },
      { position: 2, actionType: 'send_audio', messageText: null, audioId: null },
    ]);
    expect(problems).toEqual(['Etapa 1: escreva a mensagem.', 'Etapa 2: escolha o áudio.']);
  });

  it('todo motivo de cancelamento ou falha tem texto em português', () => {
    for (const reason of [
      'lead_respondeu',
      'automacao_arquivada',
      'lead_bloqueado',
      'lead_anonimizado',
      'lead_removido',
      'numero_removido',
      'executor_interrompido',
      'etapa_invalida',
      'variavel_desconhecida',
      'audio_indisponivel',
      'sem_whatsapp',
      'conversa_ambigua',
      'envio_recusado',
      'resultado_incerto',
      'tentativas_esgotadas',
      'erro_interno',
    ]) {
      expect(runReasonLabel(reason), reason).not.toBe(reason);
    }
    expect(runReasonLabel(null)).toBeNull();
    expect(runReasonLabel('algo_novo')).toBe('algo_novo');
  });
});
