import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/server/lib/errors';
import {
  automationCreateSchema,
  automationListSchema,
  automationStatusSchema,
  automationUpdateSchema,
  parseAutomationId,
  parseStepId,
  stepCreateSchema,
  stepReorderSchema,
  stepUpdateSchema,
} from '../../src/server/modules/automations/validation';
import { AUTOMATION_STATUSES, AUTOMATION_TRIGGERS } from '../../src/shared/automations';

describe('automações: criar', () => {
  it('só o nome é obrigatório; sem gatilho fica manual e sem descrição fica nula', () => {
    expect(automationCreateSchema.parse({ name: 'Follow-up de 24h' })).toEqual({
      name: 'Follow-up de 24h',
      description: null,
      trigger: 'manual',
    });
  });

  it('limpa os espaços e aceita descrição e gatilho', () => {
    expect(
      automationCreateSchema.parse({
        name: '  Retorno  ',
        description: '  Chama de novo quem não respondeu  ',
        trigger: 'lead_called',
      }),
    ).toEqual({ name: 'Retorno', description: 'Chama de novo quem não respondeu', trigger: 'lead_called' });
  });

  it('descrição vazia ou nula vira nula', () => {
    expect(automationCreateSchema.parse({ name: 'A', description: '   ' }).description).toBeNull();
    expect(automationCreateSchema.parse({ name: 'A', description: null }).description).toBeNull();
  });

  it('recusa nome vazio, só com espaços, ausente ou grande demais', () => {
    for (const name of ['', '   ', undefined, 'x'.repeat(81)]) {
      expect(automationCreateSchema.safeParse({ name }).success, String(name)).toBe(false);
    }
    expect(automationCreateSchema.safeParse({ name: 'x'.repeat(80) }).success).toBe(true);
  });

  it('recusa descrição grande demais e gatilho desconhecido', () => {
    expect(automationCreateSchema.safeParse({ name: 'A', description: 'x'.repeat(501) }).success).toBe(false);
    expect(automationCreateSchema.safeParse({ name: 'A', trigger: 'lead_deleted' }).success).toBe(false);
  });

  it('aceita todos os gatilhos previstos', () => {
    for (const trigger of AUTOMATION_TRIGGERS) {
      expect(automationCreateSchema.parse({ name: 'A', trigger }).trigger).toBe(trigger);
    }
  });

  it('não deixa passar campos que o cliente não pode definir', () => {
    const parsed = automationCreateSchema.parse({ name: 'A', status: 'active', createdBy: 'x', id: 1 });
    expect(Object.keys(parsed).sort()).toEqual(['description', 'name', 'trigger']);
  });
});

describe('automações: atualizar', () => {
  it('manda só o que muda: os campos ausentes não aparecem no resultado', () => {
    expect(automationUpdateSchema.parse({ name: ' Novo nome ' })).toEqual({ name: 'Novo nome' });
    expect(automationUpdateSchema.parse({ trigger: 'lead_created' })).toEqual({ trigger: 'lead_created' });
  });

  it('descrição vazia apaga a descrição (nula), sem tocar nos outros campos', () => {
    expect(automationUpdateSchema.parse({ description: '' })).toEqual({ description: null });
    expect(automationUpdateSchema.parse({ description: null })).toEqual({ description: null });
  });

  it('exige pelo menos um campo', () => {
    expect(automationUpdateSchema.safeParse({}).success).toBe(false);
    expect(automationUpdateSchema.safeParse({ status: 'active' }).success).toBe(false);
  });

  it('aplica as mesmas regras da criação', () => {
    expect(automationUpdateSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(automationUpdateSchema.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
    expect(automationUpdateSchema.safeParse({ description: 'x'.repeat(501) }).success).toBe(false);
    expect(automationUpdateSchema.safeParse({ trigger: 'nada' }).success).toBe(false);
  });
});

describe('automações: situação', () => {
  it('aceita ativar e pausar', () => {
    expect(automationStatusSchema.parse({ status: 'active' })).toEqual({ status: 'active' });
    expect(automationStatusSchema.parse({ status: 'paused' })).toEqual({ status: 'paused' });
  });

  it('rascunho e arquivada não se escolhem aqui (arquivar tem rota própria)', () => {
    for (const status of ['draft', 'archived', 'ativa', '', null, undefined]) {
      expect(automationStatusSchema.safeParse({ status }).success, String(status)).toBe(false);
    }
    expect(automationStatusSchema.safeParse({}).success).toBe(false);
  });

  it('só usa situações que existem', () => {
    for (const status of automationStatusSchema.shape.status.options) {
      expect(AUTOMATION_STATUSES).toContain(status);
    }
  });
});

describe('automações: listar', () => {
  it('por padrão não traz as arquivadas; ?archived=1 traz só elas', () => {
    expect(automationListSchema.parse({})).toEqual({ archived: '0' });
    expect(automationListSchema.parse({ archived: '1' })).toEqual({ archived: '1' });
    expect(automationListSchema.safeParse({ archived: 'sim' }).success).toBe(false);
  });
});

describe('automações: id da rota', () => {
  it('aceita número inteiro positivo, inclusive vindo como texto', () => {
    expect(parseAutomationId('7')).toBe(7);
    expect(parseAutomationId(12)).toBe(12);
  });

  it('id inválido responde 404 (não revela nada)', () => {
    for (const raw of ['abc', '0', '-1', '1.5', '', undefined, null]) {
      try {
        parseAutomationId(raw);
        expect.unreachable(`deveria recusar ${String(raw)}`);
      } catch (error) {
        expect(error, String(raw)).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode, String(raw)).toBe(404);
      }
    }
  });
});

describe('etapas: criar', () => {
  const base = { actionType: 'send_text', delaySeconds: 0, messageText: 'Olá, {{nome}}!', conditions: [] };

  it('aceita etapa de texto; a espera 0 é imediatamente e as variáveis ficam como escritas', () => {
    expect(stepCreateSchema.parse(base)).toEqual({
      position: undefined,
      actionType: 'send_text',
      delaySeconds: 0,
      messageText: 'Olá, {{nome}}!',
      audioMode: 'fixed',
      audioId: null,
      conditions: [],
    });
  });

  it('cada tipo guarda só o que é dele', () => {
    const audio = stepCreateSchema.parse({
      ...base,
      actionType: 'send_audio',
      audioId: 4,
      messageText: 'sobra',
    });
    expect(audio).toMatchObject({ actionType: 'send_audio', audioId: 4, messageText: null });
    const text = stepCreateSchema.parse({ ...base, audioId: 4 });
    expect(text).toMatchObject({ actionType: 'send_text', audioId: null, messageText: 'Olá, {{nome}}!' });
  });

  it('etapa de texto exige a mensagem, com mensagem de erro em português', () => {
    for (const messageText of [undefined, null, '', '   ']) {
      const r = stepCreateSchema.safeParse({ ...base, messageText });
      expect(r.success, String(messageText)).toBe(false);
    }
    const r = stepCreateSchema.safeParse({ ...base, messageText: undefined });
    expect(r.success ? '' : (r.error.issues[0]?.message ?? '')).toContain('mensagem');
  });

  it('etapa de áudio exige o áudio', () => {
    expect(stepCreateSchema.safeParse({ ...base, actionType: 'send_audio' }).success).toBe(false);
    expect(stepCreateSchema.safeParse({ ...base, actionType: 'send_audio', audioId: null }).success).toBe(
      false,
    );
    expect(stepCreateSchema.safeParse({ ...base, actionType: 'send_audio', audioId: 0 }).success).toBe(false);
    expect(stepCreateSchema.safeParse({ ...base, actionType: 'send_audio', audioId: 3 }).success).toBe(true);
  });

  it('confere o tipo da ação, a espera, o tamanho do texto e a posição', () => {
    expect(stepCreateSchema.safeParse({ ...base, actionType: 'send_video' }).success).toBe(false);
    for (const delaySeconds of [-1, 1.5, 31_536_001, '60', null, undefined]) {
      expect(stepCreateSchema.safeParse({ ...base, delaySeconds }).success, String(delaySeconds)).toBe(false);
    }
    expect(stepCreateSchema.safeParse({ ...base, delaySeconds: 31_536_000 }).success).toBe(true);
    expect(stepCreateSchema.safeParse({ ...base, messageText: 'x'.repeat(4097) }).success).toBe(false);
    expect(stepCreateSchema.safeParse({ ...base, messageText: 'x'.repeat(4096) }).success).toBe(true);
    for (const position of [0, -1, 1.5, 21]) {
      expect(stepCreateSchema.safeParse({ ...base, position }).success, String(position)).toBe(false);
    }
    expect(stepCreateSchema.parse({ ...base, position: 2 }).position).toBe(2);
  });

  it('condições: o valor combina com o campo (resultado, situação, respondeu, lista)', () => {
    const list = '3b241101-e2bb-4255-8caf-4136c566a962';
    const ok = [
      { field: 'lead_result', operator: 'is', value: 'respondeu' },
      { field: 'lead_replied', operator: 'is_not', value: true },
      { field: 'lead_status', operator: 'is', value: 'bloqueado' },
      { field: 'lead_list', operator: 'is', value: list },
    ];
    expect(stepCreateSchema.parse({ ...base, conditions: ok }).conditions).toEqual(ok);
    const bad = [
      { field: 'lead_result', operator: 'is', value: 'fechado' },
      { field: 'lead_result', operator: 'is', value: false },
      { field: 'lead_replied', operator: 'is', value: 'sim' },
      { field: 'lead_status', operator: 'is', value: 'perdido' },
      { field: 'lead_list', operator: 'is', value: 'lista-1' },
      { field: 'lead_owner', operator: 'is', value: 'x' },
      { field: 'lead_result', operator: 'equals', value: 'respondeu' },
      { field: 'lead_replied', operator: 'is', value: true, extra: 1 },
      { type: 'lead_not_replied' },
    ];
    for (const condition of bad) {
      const r = stepCreateSchema.safeParse({ ...base, conditions: [condition] });
      expect(r.success, JSON.stringify(condition)).toBe(false);
    }
    const eleven = Array(11).fill(ok[1]);
    expect(stepCreateSchema.safeParse({ ...base, conditions: eleven }).success).toBe(false);
    expect(stepCreateSchema.safeParse({ ...base, conditions: eleven.slice(0, 10) }).success).toBe(true);
  });
});

describe('etapas: alterar e reordenar', () => {
  it('alterar: manda-se só o que muda, mas pelo menos um campo', () => {
    expect(stepUpdateSchema.parse({ delaySeconds: 3600 })).toEqual({ delaySeconds: 3600 });
    expect(stepUpdateSchema.parse({ messageText: null })).toEqual({ messageText: null });
    expect(stepUpdateSchema.safeParse({}).success).toBe(false);
    expect(stepUpdateSchema.safeParse({ position: 3 }).success).toBe(false); // a posição não é uma alteração (ver reordenar)
    expect(stepUpdateSchema.parse({ position: 3, delaySeconds: 5 })).toEqual({ delaySeconds: 5 });
  });

  it('alterar aplica as mesmas regras de valor da criação', () => {
    expect(stepUpdateSchema.safeParse({ delaySeconds: -5 }).success).toBe(false);
    expect(stepUpdateSchema.safeParse({ messageText: '' }).success).toBe(false);
    expect(stepUpdateSchema.safeParse({ actionType: 'x' }).success).toBe(false);
    expect(stepUpdateSchema.safeParse({ audioId: 0 }).success).toBe(false);
  });

  it('reordenar: lista de ids sem repetição, de 1 a 20', () => {
    expect(stepReorderSchema.parse({ stepIds: [5, 3, 4, 1] })).toEqual({ stepIds: [5, 3, 4, 1] });
    expect(stepReorderSchema.safeParse({ stepIds: [] }).success).toBe(false);
    expect(stepReorderSchema.safeParse({ stepIds: [1, 1] }).success).toBe(false);
    expect(stepReorderSchema.safeParse({ stepIds: [1, 'a'] }).success).toBe(false);
    expect(stepReorderSchema.safeParse({ stepIds: [0] }).success).toBe(false);
    expect(stepReorderSchema.safeParse({}).success).toBe(false);
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(stepReorderSchema.safeParse({ stepIds: twenty }).success).toBe(true);
    expect(stepReorderSchema.safeParse({ stepIds: [...twenty, 21] }).success).toBe(false);
  });

  it('id de etapa inválido responde 404', () => {
    expect(parseStepId('12')).toBe(12);
    for (const raw of ['abc', '0', '-1', '', undefined]) {
      try {
        parseStepId(raw);
        expect.unreachable(`deveria recusar ${String(raw)}`);
      } catch (error) {
        expect((error as AppError).statusCode).toBe(404);
      }
    }
  });
});
