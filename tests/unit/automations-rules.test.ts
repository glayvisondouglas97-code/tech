import { describe, expect, it } from 'vitest';
import { canChangeStatus, statusChangeProblem } from '../../src/server/modules/automations/service';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_CONDITION_FIELDS,
  AUTOMATION_CONDITION_OPERATORS,
  AUTOMATION_RUN_STATUSES,
  AUTOMATION_SETTABLE_STATUSES,
  AUTOMATION_STATUSES,
  AUTOMATION_STEP_RUN_STATUSES,
  AUTOMATION_TRIGGERS,
  AUTOMATION_VARIABLES,
  automationProblems,
  LEAD_STATUSES,
  stepProblem,
  unknownVariables,
} from '../../src/shared/automations';
import { can, ROLES } from '../../src/shared/roles';

describe('automações: mudança de situação', () => {
  it('rascunho ativa ou arquiva; só a ativa pausa; a pausada ativa de novo', () => {
    expect(canChangeStatus('draft', 'active')).toBe(true);
    expect(canChangeStatus('draft', 'paused')).toBe(false);
    expect(canChangeStatus('active', 'paused')).toBe(true);
    expect(canChangeStatus('paused', 'active')).toBe(true);
  });

  it('qualquer uma que não foi arquivada pode ser arquivada', () => {
    for (const from of ['draft', 'active', 'paused'] as const) {
      expect(canChangeStatus(from, 'archived'), from).toBe(true);
    }
  });

  it('arquivada não volta para nenhuma situação', () => {
    for (const to of AUTOMATION_STATUSES) {
      expect(canChangeStatus('archived', to), to).toBe(false);
    }
  });

  it('ninguém "muda" para a situação em que já está, e nada volta a rascunho', () => {
    for (const status of AUTOMATION_STATUSES) {
      expect(canChangeStatus(status, status), status).toBe(false);
      expect(canChangeStatus(status, 'draft'), status).toBe(false);
    }
  });
});

describe('automações: mensagem quando a mudança não é permitida', () => {
  it('toda mudança recusada tem uma explicação, e ela combina com o motivo', () => {
    for (const from of AUTOMATION_STATUSES) {
      for (const to of AUTOMATION_STATUSES) {
        if (canChangeStatus(from, to)) continue;
        expect(statusChangeProblem(from, to), `${from} → ${to}`).toMatch(/\S{3,}/);
      }
    }
    expect(statusChangeProblem('archived', 'active')).toContain('arquivada');
    expect(statusChangeProblem('archived', 'archived')).toContain('arquivada');
    expect(statusChangeProblem('active', 'active')).toBe('A automação já está ativa.');
    expect(statusChangeProblem('paused', 'paused')).toBe('A automação já está pausada.');
    expect(statusChangeProblem('draft', 'paused')).toBe('Só uma automação ativa pode ser pausada.');
  });
});

describe('automações: permissão', () => {
  it('só o dono e o administrador gerenciam automações', () => {
    expect(ROLES.filter((role) => can.manageAutomations(role))).toEqual(['dono', 'admin']);
  });

  it('não mexe nas permissões que já existiam', () => {
    // Tabela conferida antes da Parte 1: supervisor continua vendo tudo, mas sem gestão de números/áudios.
    expect(can.manageAudios('supervisor')).toBe(false);
    expect(can.manageNumbers('supervisor')).toBe(false);
    expect(can.manageSettings('admin')).toBe(true);
    expect(can.seeAllLeads('supervisor')).toBe(true);
    expect(can.seeAllNumbers('atendente')).toBe(false);
  });

  it('quem gerencia automações também pode listar os áudios (a etapa escolhe áudio da biblioteca)', () => {
    for (const role of ROLES) {
      if (can.manageAutomations(role)) expect(can.manageAudios(role), role).toBe(true);
    }
  });
});

describe('automações: conferência das etapas (a mesma no servidor e na tela)', () => {
  const text = (messageText: string | null) => ({
    actionType: 'send_text' as const,
    messageText,
    audioId: null,
  });
  const audio = (audioId: number | null) => ({
    actionType: 'send_audio' as const,
    messageText: null,
    audioId,
  });

  it('etapa de texto precisa de mensagem; a de áudio, de um áudio', () => {
    expect(stepProblem(text('Olá!'))).toBeNull();
    expect(stepProblem(text(null))).toContain('mensagem');
    expect(stepProblem(text(''))).toContain('mensagem');
    expect(stepProblem(text('   '))).toContain('mensagem');
    expect(stepProblem(audio(7))).toBeNull();
    expect(stepProblem(audio(null))).toContain('áudio');
  });

  it('sem etapas não dá para ativar; com etapa incompleta, diz qual', () => {
    expect(automationProblems([])).toEqual(['Adicione pelo menos uma etapa.']);
    expect(automationProblems([{ position: 1, ...text('Oi') }])).toEqual([]);
    expect(
      automationProblems([
        { position: 1, ...text('Oi') },
        { position: 2, ...audio(null) },
        { position: 3, ...text(' ') },
      ]),
    ).toEqual(['Etapa 2: escolha o áudio.', 'Etapa 3: escreva a mensagem.']);
  });

  it('acha variáveis {{...}} que não existem, sem repetir', () => {
    expect(unknownVariables('Oi {{nome}}, da {{empresa}}! {{telefone}} {{atendente}} {{numero}}')).toEqual(
      [],
    );
    expect(unknownVariables('Oi {{nome}} {{nomee}} {{nomee}} {{ outra }}')).toEqual(['nomee', 'outra']);
    expect(unknownVariables('sem variáveis, só {chaves} simples')).toEqual([]);
    expect(AUTOMATION_VARIABLES.map((v) => v.name)).toEqual([
      'nome',
      'empresa',
      'telefone',
      'atendente',
      'numero',
    ]);
  });
});

describe('automações: listas de tipos', () => {
  it('não têm valores repetidos e trazem o que a Parte 1 promete', () => {
    for (const list of [
      AUTOMATION_STATUSES,
      AUTOMATION_TRIGGERS,
      AUTOMATION_ACTION_TYPES,
      AUTOMATION_CONDITION_FIELDS,
      AUTOMATION_CONDITION_OPERATORS,
      LEAD_STATUSES,
    ]) {
      expect(new Set(list).size).toBe(list.length);
    }
    expect([...AUTOMATION_STATUSES]).toEqual(['draft', 'active', 'paused', 'archived']);
    expect([...AUTOMATION_TRIGGERS]).toEqual(['lead_called', 'lead_created', 'manual']);
    expect([...AUTOMATION_RUN_STATUSES]).toEqual(['pending', 'running', 'completed', 'cancelled', 'failed']);
  });

  it('as situações escolhíveis existem, e as das etapas incluem as da participação', () => {
    for (const status of AUTOMATION_SETTABLE_STATUSES) expect(AUTOMATION_STATUSES).toContain(status);
    for (const status of AUTOMATION_RUN_STATUSES) expect(AUTOMATION_STEP_RUN_STATUSES).toContain(status);
    expect(AUTOMATION_STEP_RUN_STATUSES).toContain('skipped');
  });
});
