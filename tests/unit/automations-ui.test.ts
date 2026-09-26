import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_AUDIO_MODES,
  AUTOMATION_CONDITION_FIELDS,
  AUTOMATION_STATUSES,
  CAMPAIGN_STATUSES,
} from '../../src/shared/automations';
import {
  AUDIO_MODE_LABELS,
  CAMPAIGN_STATUS_INFO,
  campaignEndLabel,
  delayToSeconds,
  describeCondition,
  formatDelay,
  isConditionComplete,
  isValidDelay,
  newCondition,
  parseDelay,
  runReasonLabel,
  STATUS_INFO,
  splitDelay,
} from '../../src/web/lib/automations';

// A parte da tela que não depende do navegador: espera (segundos ⇄ quantidade + unidade) e condições.

describe('tela de automações: espera', () => {
  it('converte quantidade + unidade em segundos', () => {
    expect(delayToSeconds(0, 'minutes')).toBe(0);
    expect(delayToSeconds(45, 'seconds')).toBe(45);
    expect(delayToSeconds(1, 'minutes')).toBe(60);
    expect(delayToSeconds(2, 'hours')).toBe(7200);
    expect(delayToSeconds(1, 'days')).toBe(86_400);
    expect(delayToSeconds(1.5, 'hours')).toBe(5400);
  });

  it('mostra a espera de forma humana', () => {
    expect(formatDelay(0)).toBe('Imediatamente');
    expect(formatDelay(1)).toBe('1 segundo');
    expect(formatDelay(30)).toBe('30 segundos');
    expect(formatDelay(60)).toBe('1 minuto');
    expect(formatDelay(3600)).toBe('1 hora');
    expect(formatDelay(7200)).toBe('2 horas');
    expect(formatDelay(86_400)).toBe('1 dia');
    expect(formatDelay(172_800)).toBe('2 dias');
    expect(formatDelay(5400)).toBe('1 hora e 30 minutos');
    expect(formatDelay(90_000)).toBe('1 dia e 1 hora');
    expect(formatDelay(31_536_000)).toBe('365 dias');
  });

  it('separa os segundos guardados na maior unidade que divide certo', () => {
    expect(splitDelay(0)).toEqual({ value: 0, unit: 'minutes' });
    expect(splitDelay(45)).toEqual({ value: 45, unit: 'seconds' });
    expect(splitDelay(60)).toEqual({ value: 1, unit: 'minutes' });
    expect(splitDelay(5400)).toEqual({ value: 90, unit: 'minutes' });
    expect(splitDelay(7200)).toEqual({ value: 2, unit: 'hours' });
    expect(splitDelay(86_400)).toEqual({ value: 1, unit: 'days' });
    expect(splitDelay(172_800)).toEqual({ value: 2, unit: 'days' });
  });

  it('ida e volta: o que se salva volta igual ao abrir a etapa', () => {
    for (const seconds of [0, 1, 59, 60, 61, 3600, 3660, 7200, 86_400, 90_000, 31_536_000]) {
      const { value, unit } = splitDelay(seconds);
      expect(delayToSeconds(value, unit), String(seconds)).toBe(seconds);
    }
  });

  it('lê o que a pessoa digitou (aceita vírgula) e recusa o inválido ou o absurdo', () => {
    expect(parseDelay('2', 'hours')).toBe(7200);
    expect(parseDelay(' 0 ', 'minutes')).toBe(0);
    expect(parseDelay('1,5', 'hours')).toBe(5400);
    expect(parseDelay('1.5', 'hours')).toBe(5400);
    expect(parseDelay('365', 'days')).toBe(31_536_000);
    for (const text of ['', ' ', 'abc', '-1', '1e3', '1,2,3', '366']) {
      expect(parseDelay(text, text === '366' ? 'days' : 'minutes'), text).toBeNull();
    }
    expect(parseDelay('99999999', 'seconds')).toBeNull();
    expect(isValidDelay(31_536_001)).toBe(false);
    expect(isValidDelay(-1)).toBe(false);
    expect(isValidDelay(1.5)).toBe(false);
  });
});

describe('tela de automações: condições e situações', () => {
  it('cria cada tipo de condição com um valor inicial que faz sentido', () => {
    expect(newCondition('lead_result')).toEqual({ field: 'lead_result', operator: 'is', value: 'respondeu' });
    expect(newCondition('lead_replied')).toEqual({ field: 'lead_replied', operator: 'is', value: true });
    expect(newCondition('lead_status')).toEqual({ field: 'lead_status', operator: 'is', value: 'pendente' });
    expect(newCondition('lead_list', 'abc')).toEqual({ field: 'lead_list', operator: 'is', value: 'abc' });
    for (const field of AUTOMATION_CONDITION_FIELDS) expect(newCondition(field).field).toBe(field);
  });

  it('descreve a condição em português', () => {
    expect(describeCondition({ field: 'lead_result', operator: 'is', value: 'respondeu' })).toBe(
      'Resultado do lead é Respondeu',
    );
    expect(describeCondition({ field: 'lead_replied', operator: 'is_not', value: true })).toBe(
      'Lead respondeu não é Sim',
    );
    expect(describeCondition({ field: 'lead_status', operator: 'is', value: 'chamado' })).toBe(
      'Situação do lead é Chamado',
    );
    const names = (id: string) => (id === 'l1' ? 'Clientes de setembro' : undefined);
    expect(describeCondition({ field: 'lead_list', operator: 'is', value: 'l1' }, names)).toBe(
      'Lista do lead é Clientes de setembro',
    );
    expect(describeCondition({ field: 'lead_list', operator: 'is', value: 'apagada' }, names)).toBe(
      'Lista do lead é lista removida',
    );
  });

  it('condição de lista sem lista escolhida está incompleta', () => {
    expect(isConditionComplete(newCondition('lead_list'))).toBe(false);
    expect(isConditionComplete(newCondition('lead_list', 'x'))).toBe(true);
    expect(isConditionComplete(newCondition('lead_result'))).toBe(true);
  });

  it('cada situação da automação tem rótulo em português', () => {
    expect(STATUS_INFO.draft.label).toBe('Rascunho');
    expect(STATUS_INFO.active.label).toBe('Ativa');
    expect(STATUS_INFO.paused.label).toBe('Pausada');
    expect(STATUS_INFO.archived.label).toBe('Arquivada');
    for (const status of AUTOMATION_STATUSES) expect(STATUS_INFO[status].label).toBeTruthy();
  });
});

describe('tela de automações: campanhas e áudio sorteado', () => {
  it('cada situação da campanha tem rótulo e cor, e "Concluída" é diferente de "Encerrada"', () => {
    expect(Object.keys(CAMPAIGN_STATUS_INFO).sort()).toEqual([...CAMPAIGN_STATUSES].sort());
    expect(CAMPAIGN_STATUS_INFO.active).toEqual({ label: 'Ativa', tone: 'ok' });
    expect(CAMPAIGN_STATUS_INFO.paused).toEqual({ label: 'Pausada', tone: 'warn' });
    expect(CAMPAIGN_STATUS_INFO.stopped.label).toBe('Encerrada');
    expect(CAMPAIGN_STATUS_INFO.finished.label).toBe('Concluída');
  });

  it('o modo do áudio tem rótulo para cada opção', () => {
    expect(Object.keys(AUDIO_MODE_LABELS).sort()).toEqual([...AUTOMATION_AUDIO_MODES].sort());
    expect(AUDIO_MODE_LABELS.fixed).toBe('Áudio fixo');
    expect(AUDIO_MODE_LABELS.random).toMatch(/Sortear/);
  });

  it('o motivo do fim da campanha e da participação aparece em português', () => {
    expect(campaignEndLabel('encerrada_manualmente')).toBe('Encerrada por uma pessoa');
    expect(campaignEndLabel('lista_esgotada')).toMatch(/lista/);
    expect(campaignEndLabel(null)).toBeNull();
    expect(campaignEndLabel('motivo_novo')).toBe('motivo_novo'); // o que não se conhece aparece como veio
    expect(runReasonLabel('campanha_encerrada')).toBe('A campanha foi encerrada');
    expect(runReasonLabel('lead_indisponivel')).toMatch(/atendido/);
  });
});
