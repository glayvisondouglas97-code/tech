/**
 * Etapas das automações: criar, alterar, excluir e reordenar.
 *
 * Cada operação roda numa transação com a automação travada (FOR UPDATE): dois gestores editando ao
 * mesmo tempo não se atropelam e as posições nunca ficam repetidas. Todas devolvem a lista completa
 * das etapas, já na ordem nova (criar e excluir mudam a posição das outras).
 *
 * Aqui só se guarda configuração. Nada agenda, executa condições, espera o atraso ou envia mensagem:
 * isso é do executor, que vem depois. Também não chama a Evolution.
 */
import { sql } from 'kysely';
import { AUTOMATION_MAX_STEPS, stepProblem } from '../../../shared/automations';
import type { AuthUser } from '../../auth/sessions';
import type { Db } from '../../db';
import type { Automation, AutomationStep as AutomationStepRow } from '../../db/schema';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { lockAutomation, stepDto } from './service';
import type { AutomationCondition, AutomationStep } from './types';
import type { NewStepInput, StepChangesInput } from './validation';

const STEP_NOT_FOUND = 'Etapa não encontrada.';

/** Automação arquivada fica só para consulta: não recebe, muda nem perde etapas. */
function assertEditable(automation: Automation): void {
  if (automation.status === 'archived') {
    throw conflict('Uma automação arquivada não pode ser alterada: ela fica só para consulta.');
  }
}

const orderedSteps = (db: Db, automationId: number): Promise<AutomationStepRow[]> =>
  db
    .selectFrom('automation_steps')
    .selectAll()
    .where('automation_id', '=', automationId)
    .orderBy('position')
    .execute();

async function stepsOf(db: Db, automationId: number): Promise<AutomationStep[]> {
  return (await orderedSteps(db, automationId)).map(stepDto);
}

/** A etapa pertence a esta automação? Etapa de outra automação responde 404 (não revela que existe). */
async function findStep(db: Db, automationId: number, stepId: number): Promise<AutomationStepRow> {
  const step = await db
    .selectFrom('automation_steps')
    .selectAll()
    .where('id', '=', stepId)
    .where('automation_id', '=', automationId)
    .executeTakeFirst();
  if (!step) throw notFound(STEP_NOT_FOUND);
  return step;
}

/** Mexer nas etapas é mexer na automação: a data de alteração dela acompanha. */
async function touch(db: Db, automationId: number): Promise<void> {
  await db
    .updateTable('automations')
    .set({ updated_at: sql`now()` })
    .where('id', '=', automationId)
    .execute();
}

/** O áudio e as listas citados existem? (Conferido ao gravar; o que for apagado depois é tratado no uso.) */
async function assertReferences(
  db: Db,
  refs: { audioId?: number | null; conditions?: AutomationCondition[] },
): Promise<void> {
  if (refs.audioId != null) {
    const audio = await db
      .selectFrom('wa_audios')
      .select('id')
      .where('id', '=', refs.audioId)
      .executeTakeFirst();
    if (!audio) throw badRequest('Áudio não encontrado. Escolha outro da biblioteca.');
  }
  const listIds = [
    ...new Set((refs.conditions ?? []).flatMap((c) => (c.field === 'lead_list' ? [c.value] : []))),
  ];
  if (listIds.length) {
    const found = await db.selectFrom('lists').select('id').where('id', 'in', listIds).execute();
    if (found.length !== listIds.length) throw badRequest('Uma das listas das condições não existe.');
  }
}

/** Cada tipo guarda só o que é dele: a etapa de áudio não leva texto e a de texto não leva áudio. */
function normalized<
  T extends {
    actionType: string;
    messageText: string | null;
    audioId: number | null;
    audioMode: 'fixed' | 'random';
  },
>(step: T): T {
  const audio = step.actionType === 'send_audio';
  return {
    ...step,
    messageText: step.actionType === 'send_text' ? step.messageText : null,
    // Só a etapa de áudio tem modo; no sorteio não há áudio fixo.
    audioMode: audio ? step.audioMode : 'fixed',
    audioId: audio && step.audioMode !== 'random' ? step.audioId : null,
  };
}

// ---------- operações ----------
// Quem pode usar cada uma já foi conferido na rota (`requirePermission(req, 'manageAutomations')`).

/** As etapas da automação, na ordem. 404 se a automação não existir (arquivada também pode ser vista). */
export async function listSteps(db: Db, _user: AuthUser, automationId: number): Promise<AutomationStep[]> {
  const automation = await db
    .selectFrom('automations')
    .select('id')
    .where('id', '=', automationId)
    .executeTakeFirst();
  if (!automation) throw notFound('Automação não encontrada.');
  return stepsOf(db, automationId);
}

/**
 * Cria uma etapa na posição pedida (as seguintes descem) ou no fim. A de texto precisa do texto e a de
 * áudio, de um áudio que exista. 409 se a automação estiver arquivada ou já tiver o máximo de etapas.
 */
export async function createStep(
  db: Db,
  user: AuthUser,
  automationId: number,
  input: NewStepInput,
  ip: string | null,
): Promise<AutomationStep[]> {
  await db.transaction().execute(async (trx) => {
    assertEditable(await lockAutomation(trx, automationId));
    const count = (await orderedSteps(trx, automationId)).length;
    if (count >= AUTOMATION_MAX_STEPS) {
      throw conflict(`Uma automação pode ter no máximo ${AUTOMATION_MAX_STEPS} etapas.`);
    }
    const position = input.position ?? count + 1;
    if (position > count + 1) throw badRequest(`A posição da etapa vai de 1 a ${count + 1}.`);
    await assertReferences(trx, input);

    // As de baixo descem uma posição. A unicidade da posição só é conferida no fim do comando.
    await trx
      .updateTable('automation_steps')
      .set({ position: sql<number>`position + 1`, updated_at: sql`now()` })
      .where('automation_id', '=', automationId)
      .where('position', '>=', position)
      .execute();
    await trx
      .insertInto('automation_steps')
      .values({
        automation_id: automationId,
        position,
        action_type: input.actionType,
        delay_seconds: input.delaySeconds,
        message_text: input.messageText,
        audio_id: input.audioId,
        audio_mode: input.audioMode,
        conditions: JSON.stringify(input.conditions),
      })
      .execute();
    await touch(trx, automationId);
    await audit(trx, {
      userId: user.id,
      action: 'criou_etapa_automacao',
      entity: 'automacao',
      entityId: automationId,
      details: { etapa: position, acao: input.actionType },
      ip,
    });
  });
  return stepsOf(db, automationId);
}

/**
 * Altera só o que foi enviado, conferindo o resultado inteiro (trocar para texto exige a mensagem; trocar
 * para áudio exige o áudio). Etapa de outra automação responde 404. Sem mudança de verdade, não grava.
 */
export async function updateStep(
  db: Db,
  user: AuthUser,
  automationId: number,
  stepId: number,
  changes: StepChangesInput,
  ip: string | null,
): Promise<AutomationStep[]> {
  await db.transaction().execute(async (trx) => {
    assertEditable(await lockAutomation(trx, automationId));
    const current = await findStep(trx, automationId, stepId);

    const next = normalized({
      actionType: changes.actionType ?? current.action_type,
      delaySeconds: changes.delaySeconds ?? current.delay_seconds,
      messageText: changes.messageText !== undefined ? changes.messageText : current.message_text,
      audioId: changes.audioId !== undefined ? changes.audioId : current.audio_id,
      audioMode: changes.audioMode ?? current.audio_mode,
      conditions: changes.conditions ?? current.conditions,
    });
    const problem = stepProblem(next);
    if (problem) throw badRequest(`Etapa incompleta: ${problem}`);

    const changed = [
      next.actionType !== current.action_type && 'ação',
      next.delaySeconds !== current.delay_seconds && 'espera',
      next.messageText !== current.message_text && 'mensagem',
      (next.audioId !== current.audio_id || next.audioMode !== current.audio_mode) && 'áudio',
      JSON.stringify(next.conditions) !== JSON.stringify(current.conditions) && 'condições',
    ].filter((field): field is string => !!field);
    if (!changed.length) return;

    await assertReferences(trx, {
      audioId: next.audioId !== current.audio_id ? next.audioId : null,
      conditions: changes.conditions,
    });
    await trx
      .updateTable('automation_steps')
      .set({
        action_type: next.actionType,
        delay_seconds: next.delaySeconds,
        message_text: next.messageText,
        audio_id: next.audioId,
        audio_mode: next.audioMode,
        conditions: JSON.stringify(next.conditions),
        updated_at: sql`now()`,
      })
      .where('id', '=', stepId)
      .execute();
    await touch(trx, automationId);
    await audit(trx, {
      userId: user.id,
      action: 'alterou_etapa_automacao',
      entity: 'automacao',
      entityId: automationId,
      details: { etapa: current.position, campos: changed },
      ip,
    });
  });
  return stepsOf(db, automationId);
}

/**
 * Exclui a etapa e sobe as seguintes uma posição. Uma automação ativa não perde a última etapa (pause
 * antes). O histórico de execuções da etapa, quando existir, fica sem o vínculo (SET NULL).
 */
export async function deleteStep(
  db: Db,
  user: AuthUser,
  automationId: number,
  stepId: number,
  ip: string | null,
): Promise<AutomationStep[]> {
  await db.transaction().execute(async (trx) => {
    const automation = await lockAutomation(trx, automationId);
    assertEditable(automation);
    const step = await findStep(trx, automationId, stepId);
    if (automation.status === 'active' && (await orderedSteps(trx, automationId)).length <= 1) {
      throw conflict(
        'Uma automação ativa precisa de pelo menos uma etapa. Pause a automação antes de excluir a última.',
      );
    }
    await trx.deleteFrom('automation_steps').where('id', '=', stepId).execute();
    await trx
      .updateTable('automation_steps')
      .set({ position: sql<number>`position - 1`, updated_at: sql`now()` })
      .where('automation_id', '=', automationId)
      .where('position', '>', step.position)
      .execute();
    await touch(trx, automationId);
    await audit(trx, {
      userId: user.id,
      action: 'excluiu_etapa_automacao',
      entity: 'automacao',
      entityId: automationId,
      details: { etapa: step.position, acao: step.action_type },
      ip,
    });
  });
  return stepsOf(db, automationId);
}

/**
 * Reordena: `stepIds` são os ids de TODAS as etapas da automação, na nova ordem. Não confia na tela:
 * confere que são exatamente as etapas atuais (nenhuma a mais, a menos ou de outra automação).
 */
export async function reorderSteps(
  db: Db,
  user: AuthUser,
  automationId: number,
  stepIds: number[],
  ip: string | null,
): Promise<AutomationStep[]> {
  await db.transaction().execute(async (trx) => {
    assertEditable(await lockAutomation(trx, automationId));
    const current = await orderedSteps(trx, automationId);
    if (stepIds.length !== current.length) {
      throw badRequest(`Envie as ${current.length} etapas da automação, na nova ordem.`);
    }
    const known = new Set(current.map((s) => s.id));
    if (new Set(stepIds).size !== stepIds.length || stepIds.some((id) => !known.has(id))) {
      throw badRequest('A ordem tem etapa repetida ou que não pertence a esta automação.');
    }
    const moved = stepIds.flatMap((id, index) => {
      const step = current.find((s) => s.id === id);
      return step && step.position !== index + 1 ? [{ id, position: index + 1 }] : [];
    });
    if (!moved.length) return;

    // Durante a troca duas etapas passam pela mesma posição: a conferência fica para o fim da transação.
    await sql`SET CONSTRAINTS automation_steps_position_key DEFERRED`.execute(trx);
    for (const { id, position } of moved) {
      await trx
        .updateTable('automation_steps')
        .set({ position, updated_at: sql`now()` })
        .where('id', '=', id)
        .execute();
    }
    await touch(trx, automationId);
    await audit(trx, {
      userId: user.id,
      action: 'reordenou_etapas_automacao',
      entity: 'automacao',
      entityId: automationId,
      details: { etapas: stepIds.length, movidas: moved.length },
      ip,
    });
  });
  return stepsOf(db, automationId);
}
