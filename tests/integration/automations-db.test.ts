import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as migration from '../../src/server/db/migrations/0008_automacoes';
import * as audioMigration from '../../src/server/db/migrations/0009_automacoes_audio';
import * as raffleMigration from '../../src/server/db/migrations/0011_audio_sorteio';
import * as campaignsMigration from '../../src/server/db/migrations/0012_campanhas';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_RUN_STATUSES,
  AUTOMATION_STATUSES,
  AUTOMATION_STEP_RUN_STATUSES,
  AUTOMATION_TRIGGERS,
} from '../../src/shared/automations';
import { createTestDb, createUser, seedList, type TestDb } from '../helpers';

// O esquema das automações no Postgres de testes: chaves estrangeiras, restrições e índices.
// Aqui não passa por rota nem por serviço: é o banco sozinho garantindo a integridade.

let t: TestDb;
let userId: string;
let leadIds: number[];
let seq = 0;

beforeAll(async () => {
  t = await createTestDb();
  userId = (await createUser(t.db, { name: 'Gestora', role: 'admin' })).id;
  leadIds = (await seedList(t.db, { count: 4, createdBy: userId })).leadIds;
});
afterAll(async () => t.drop());

/** Código de erro do Postgres de uma operação que deve falhar ('ok' se ela funcionou). */
const pgCode = (op: PromiseLike<unknown>): Promise<string | undefined> =>
  Promise.resolve(op).then(
    () => 'ok',
    (error: { code?: string }) => error.code,
  );

const FK = '23503';
const UNIQUE = '23505';
const CHECK = '23514';

async function addAutomation(
  values: { name?: string; status?: (typeof AUTOMATION_STATUSES)[number]; archived?: boolean } = {},
): Promise<number> {
  seq += 1;
  const row = await t.db
    .insertInto('automations')
    .values({
      name: values.name ?? `Automação ${seq}`,
      description: null,
      trigger_type: 'manual',
      created_by: userId,
      ...(values.status ? { status: values.status } : {}),
      ...(values.archived ? { archived_at: new Date() } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function addStep(
  automationId: number,
  position: number,
  extra: Partial<{
    action_type: (typeof AUTOMATION_ACTION_TYPES)[number];
    delay_seconds: number;
    message_text: string | null;
    conditions: string;
    audio_id: number | null;
  }> = {},
): Promise<number> {
  const row = await t.db
    .insertInto('automation_steps')
    .values({
      automation_id: automationId,
      position,
      action_type: 'send_text',
      message_text: 'Olá!',
      ...extra,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function addRun(
  automationId: number,
  leadId: number,
  extra: Partial<{
    status: (typeof AUTOMATION_RUN_STATUSES)[number];
    completed_at: Date | null;
    cancelled_at: Date | null;
    current_step: number;
    next_run_at: Date | null;
  }> = {},
): Promise<number> {
  const row = await t.db
    .insertInto('automation_runs')
    .values({ automation_id: automationId, lead_id: leadId, ...extra })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function addStepRun(
  runId: number,
  stepId: number | null,
  extra: Partial<{
    status: (typeof AUTOMATION_STEP_RUN_STATUSES)[number];
    message_id: number | null;
    attempts: number;
  }> = {},
): Promise<number> {
  const row = await t.db
    .insertInto('automation_step_runs')
    .values({ automation_run_id: runId, step_id: stepId, scheduled_at: new Date(), ...extra })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Uma mensagem de WhatsApp de verdade (número, contato e conversa), para testar a chave de message_id. */
async function addMessage(): Promise<number> {
  seq += 1;
  const instance = await t.db
    .insertInto('wa_instances')
    .values({ name: `whatsapp-teste-${seq}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  const contact = await t.db
    .insertInto('wa_contacts')
    .values({ phone_jid: `5541900000${seq}@s.whatsapp.net` })
    .returning('id')
    .executeTakeFirstOrThrow();
  const conversation = await t.db
    .insertInto('wa_conversations')
    .values({ instance_id: instance.id, contact_id: contact.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  const message = await t.db
    .insertInto('wa_messages')
    .values({
      instance_id: instance.id,
      conversation_id: conversation.id,
      wa_id: `wa-msg-${seq}`,
      remote_jid: `5541900000${seq}@s.whatsapp.net`,
      from_me: true,
      type: 'text',
      text: 'Olá!',
      sent_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return message.id;
}

const countOf = async (
  table: 'automation_steps' | 'automation_runs' | 'automation_step_runs',
  col: string,
  id: number,
) => {
  const r = await sql<{
    n: number;
  }>`SELECT count(*) AS n FROM ${sql.table(table)} WHERE ${sql.ref(col)} = ${id}`.execute(t.db);
  return r.rows[0]?.n ?? 0;
};

describe('automations', () => {
  it('nasce como rascunho, sem etapas e sem data de arquivamento', async () => {
    const id = await addAutomation();
    const row = await t.db
      .selectFrom('automations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'draft', archived_at: null, description: null, created_by: userId });
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
    expect(await countOf('automation_steps', 'automation_id', id)).toBe(0);
  });

  it('aceita todos os status e gatilhos do módulo e recusa os desconhecidos', async () => {
    for (const status of AUTOMATION_STATUSES) {
      const archived = status === 'archived';
      expect(await pgCode(addAutomation({ status, archived })), status).toBe('ok');
    }
    for (const trigger of AUTOMATION_TRIGGERS) {
      const r = t.db
        .insertInto('automations')
        .values({ name: `Gatilho ${trigger}`, description: null, trigger_type: trigger });
      expect(await pgCode(r.execute()), trigger).toBe('ok');
    }
    const invalidStatus = sql`INSERT INTO automations (name, trigger_type, status) VALUES ('x1', 'manual', 'ativa')`;
    const invalidTrigger = sql`INSERT INTO automations (name, trigger_type) VALUES ('x2', 'lead_deleted')`;
    expect(await pgCode(invalidStatus.execute(t.db))).toBe(CHECK);
    expect(await pgCode(invalidTrigger.execute(t.db))).toBe(CHECK);
  });

  it('arquivada e data de arquivamento andam juntas', async () => {
    const id = await addAutomation();
    const setArchivedStatusOnly = t.db
      .updateTable('automations')
      .set({ status: 'archived' })
      .where('id', '=', id);
    expect(await pgCode(setArchivedStatusOnly.execute())).toBe(CHECK);
    const setDateOnly = t.db.updateTable('automations').set({ archived_at: new Date() }).where('id', '=', id);
    expect(await pgCode(setDateOnly.execute())).toBe(CHECK);
    const both = t.db
      .updateTable('automations')
      .set({ status: 'archived', archived_at: new Date() })
      .where('id', '=', id);
    expect(await pgCode(both.execute())).toBe('ok');
  });

  it('exige nome de 1 a 80 letras e descrição de até 500', async () => {
    const insert = (name: string, description: string | null = null) =>
      t.db.insertInto('automations').values({ name, description, trigger_type: 'manual' }).execute();
    expect(await pgCode(insert(''))).toBe(CHECK);
    expect(await pgCode(insert('x'.repeat(81)))).toBe(CHECK);
    expect(await pgCode(insert('x'.repeat(80)))).toBe('ok');
    expect(await pgCode(insert('Com descrição', 'd'.repeat(501)))).toBe(CHECK);
    expect(await pgCode(insert('Com descrição ok', 'd'.repeat(500)))).toBe('ok');
  });

  it('nome único entre as não arquivadas (sem diferenciar maiúsculas); arquivar libera o nome', async () => {
    // Só letras sem acento: o lower() do Postgres dobra as acentuadas conforme o idioma (locale) do banco.
    const first = await addAutomation({ name: 'Unico' });
    expect(await pgCode(addAutomation({ name: 'UNICO' }))).toBe(UNIQUE);
    expect(await pgCode(addAutomation({ name: 'unico' }))).toBe(UNIQUE);
    await t.db
      .updateTable('automations')
      .set({ status: 'archived', archived_at: new Date() })
      .where('id', '=', first)
      .execute();
    expect(await pgCode(addAutomation({ name: 'Unico' }))).toBe('ok');
    // Duas arquivadas com o mesmo nome podem existir.
    expect(await pgCode(addAutomation({ name: 'Unico', status: 'archived', archived: true }))).toBe('ok');
  });

  it('created_by: usuário inexistente é recusado; se o usuário sair, a automação fica sem criador', async () => {
    const ghost = t.db
      .insertInto('automations')
      .values({
        name: 'Sem dono',
        description: null,
        trigger_type: 'manual',
        created_by: '00000000-0000-0000-0000-000000000000',
      })
      .execute();
    expect(await pgCode(ghost)).toBe(FK);

    const temp = await createUser(t.db, { name: 'Temporária', role: 'admin' });
    const id = await t.db
      .insertInto('automations')
      .values({ name: 'Criada por quem sai', description: null, trigger_type: 'manual', created_by: temp.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    await t.db.deleteFrom('users').where('id', '=', temp.id).execute();
    const row = await t.db
      .selectFrom('automations')
      .select('created_by')
      .where('id', '=', id.id)
      .executeTakeFirst();
    expect(row).toEqual({ created_by: null });
  });
});

describe('automation_steps', () => {
  it('uma automação pode existir sem nenhuma etapa', async () => {
    const id = await addAutomation();
    const steps = await t.db
      .selectFrom('automation_steps')
      .select('id')
      .where('automation_id', '=', id)
      .execute();
    expect(steps).toEqual([]);
  });

  it('várias etapas na mesma automação, cada uma na sua posição', async () => {
    const id = await addAutomation();
    await addStep(id, 1);
    await addStep(id, 2, { action_type: 'send_audio', message_text: null, delay_seconds: 86_400 });
    await addStep(id, 3, { delay_seconds: 172_800 });
    const steps = await t.db
      .selectFrom('automation_steps')
      .select(['position', 'action_type', 'delay_seconds'])
      .where('automation_id', '=', id)
      .orderBy('position')
      .execute();
    expect(steps).toEqual([
      { position: 1, action_type: 'send_text', delay_seconds: 0 },
      { position: 2, action_type: 'send_audio', delay_seconds: 86_400 },
      { position: 3, action_type: 'send_text', delay_seconds: 172_800 },
    ]);
    // Outra automação tem as próprias posições.
    const other = await addAutomation();
    expect(await pgCode(addStep(other, 1))).toBe('ok');
  });

  it('não repete posição na mesma automação e a posição começa em 1', async () => {
    const id = await addAutomation();
    await addStep(id, 1);
    expect(await pgCode(addStep(id, 1))).toBe(UNIQUE);
    expect(await pgCode(addStep(id, 0))).toBe(CHECK);
  });

  it('dá para trocar duas etapas de lugar numa transação só', async () => {
    const id = await addAutomation();
    const a = await addStep(id, 1, { message_text: 'primeira' });
    const b = await addStep(id, 2, { message_text: 'segunda' });
    await t.db.transaction().execute(async (trx) => {
      await sql`SET CONSTRAINTS automation_steps_position_key DEFERRED`.execute(trx);
      await trx.updateTable('automation_steps').set({ position: 2 }).where('id', '=', a).execute();
      await trx.updateTable('automation_steps').set({ position: 1 }).where('id', '=', b).execute();
    });
    const order = await t.db
      .selectFrom('automation_steps')
      .select('message_text')
      .where('automation_id', '=', id)
      .orderBy('position')
      .execute();
    expect(order.map((s) => s.message_text)).toEqual(['segunda', 'primeira']);
  });

  it('FK: etapa de automação que não existe é recusada; excluir a automação leva as etapas', async () => {
    expect(await pgCode(addStep(999_999, 1))).toBe(FK);
    const id = await addAutomation();
    await addStep(id, 1);
    await addStep(id, 2);
    expect(await countOf('automation_steps', 'automation_id', id)).toBe(2);
    await t.db.deleteFrom('automations').where('id', '=', id).execute();
    expect(await countOf('automation_steps', 'automation_id', id)).toBe(0);
  });

  it('etapa que envia texto precisa de texto; a de áudio não precisa', async () => {
    const id = await addAutomation();
    expect(await pgCode(addStep(id, 1, { message_text: null }))).toBe(CHECK);
    expect(await pgCode(addStep(id, 1, { message_text: '   ' }))).toBe(CHECK);
    expect(await pgCode(addStep(id, 1, { message_text: 'Bom dia' }))).toBe('ok');
    expect(await pgCode(addStep(id, 2, { action_type: 'send_audio', message_text: null }))).toBe('ok');
    const unknown = sql`INSERT INTO automation_steps (automation_id, position, action_type) VALUES (${id}, 3, 'send_video')`;
    expect(await pgCode(unknown.execute(t.db))).toBe(CHECK);
  });

  it('aceita todos os tipos de ação do módulo', async () => {
    const id = await addAutomation();
    let position = 0;
    for (const action_type of AUTOMATION_ACTION_TYPES) {
      position += 1;
      expect(await pgCode(addStep(id, position, { action_type, message_text: 'texto' })), action_type).toBe(
        'ok',
      );
    }
  });

  it('atraso: 0 é imediatamente (padrão), nunca negativo; texto de até 4096 letras', async () => {
    const id = await addAutomation();
    const now = await addStep(id, 1);
    const row = await t.db
      .selectFrom('automation_steps')
      .select('delay_seconds')
      .where('id', '=', now)
      .executeTakeFirstOrThrow();
    expect(row.delay_seconds).toBe(0);
    expect(await pgCode(addStep(id, 2, { delay_seconds: -1 }))).toBe(CHECK);
    expect(await pgCode(addStep(id, 2, { delay_seconds: 31_536_001 }))).toBe(CHECK);
    expect(await pgCode(addStep(id, 2, { message_text: 'x'.repeat(4096) }))).toBe('ok');
    expect(await pgCode(addStep(id, 3, { message_text: 'x'.repeat(4097) }))).toBe(CHECK);
  });

  it('conditions guarda uma lista em JSON (vazia por padrão) e recusa o que não for lista', async () => {
    const id = await addAutomation();
    const plain = await addStep(id, 1);
    const withCondition = await addStep(id, 2, {
      conditions: JSON.stringify([{ field: 'lead_replied', operator: 'is', value: false }]),
    });
    const rows = await t.db
      .selectFrom('automation_steps')
      .select(['id', 'conditions'])
      .where('id', 'in', [plain, withCondition])
      .execute();
    expect(rows.find((r) => r.id === plain)?.conditions).toEqual([]);
    expect(rows.find((r) => r.id === withCondition)?.conditions).toEqual([
      { field: 'lead_replied', operator: 'is', value: false },
    ]);
    expect(
      await pgCode(
        addStep(id, 3, {
          conditions: JSON.stringify({ field: 'lead_replied', operator: 'is', value: false }),
        }),
      ),
    ).toBe(CHECK);
  });
});

describe('automation_runs', () => {
  it('FK: exige automação e lead que existam', async () => {
    const id = await addAutomation();
    expect(await pgCode(addRun(999_999, leadIds[0] as number))).toBe(FK);
    expect(await pgCode(addRun(id, 999_999))).toBe(FK);
  });

  it('nasce pendente, na etapa 1 e sem hora marcada', async () => {
    const id = await addAutomation();
    const run = await addRun(id, leadIds[0] as number);
    const row = await t.db
      .selectFrom('automation_runs')
      .selectAll()
      .where('id', '=', run)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'pending',
      current_step: 1,
      next_run_at: null,
      started_at: null,
      completed_at: null,
      cancelled_at: null,
      cancel_reason: null,
    });
  });

  it('guarda "este lead está na etapa 2 e a próxima ação é às 14:30"', async () => {
    const id = await addAutomation();
    const run = await addRun(id, leadIds[1] as number);
    const at = new Date('2026-09-26T14:30:00-03:00');
    await t.db
      .updateTable('automation_runs')
      .set({ status: 'running', current_step: 2, next_run_at: at, started_at: new Date() })
      .where('id', '=', run)
      .execute();
    const row = await t.db
      .selectFrom('automation_runs')
      .select(['status', 'current_step', 'next_run_at'])
      .where('id', '=', run)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('running');
    expect(row.current_step).toBe(2);
    expect(row.next_run_at?.toISOString()).toBe(at.toISOString());
  });

  it('aceita todos os status do módulo e recusa os desconhecidos', async () => {
    for (const [index, status] of AUTOMATION_RUN_STATUSES.entries()) {
      const id = await addAutomation();
      const stamps = {
        completed_at: status === 'completed' ? new Date() : null,
        cancelled_at: status === 'cancelled' ? new Date() : null,
      };
      expect(
        await pgCode(addRun(id, leadIds[index % leadIds.length] as number, { status, ...stamps })),
        status,
      ).toBe('ok');
    }
    const id = await addAutomation();
    const invalid = sql`INSERT INTO automation_runs (automation_id, lead_id, status) VALUES (${id}, ${leadIds[0]}, 'paused')`;
    expect(await pgCode(invalid.execute(t.db))).toBe(CHECK);
  });

  it('concluída e cancelada precisam da respectiva data, e só elas a têm', async () => {
    const id = await addAutomation();
    const lead = leadIds[2] as number;
    expect(await pgCode(addRun(id, lead, { status: 'completed' }))).toBe(CHECK);
    expect(await pgCode(addRun(id, lead, { status: 'cancelled' }))).toBe(CHECK);
    expect(await pgCode(addRun(id, lead, { status: 'pending', completed_at: new Date() }))).toBe(CHECK);
    expect(await pgCode(addRun(id, lead, { status: 'running', cancelled_at: new Date() }))).toBe(CHECK);
    const reason = t.db
      .insertInto('automation_runs')
      .values({
        automation_id: id,
        lead_id: lead,
        status: 'cancelled',
        cancelled_at: new Date(),
        cancel_reason: 'lead_replied',
      })
      .execute();
    expect(await pgCode(reason)).toBe('ok');
  });

  it('o mesmo lead não participa duas vezes ao mesmo tempo da mesma automação', async () => {
    const id = await addAutomation();
    const lead = leadIds[3] as number;
    const first = await addRun(id, lead);
    expect(await pgCode(addRun(id, lead))).toBe(UNIQUE);
    expect(await pgCode(addRun(id, lead, { status: 'running' }))).toBe(UNIQUE);
    // Outro lead, ou outra automação, pode.
    expect(await pgCode(addRun(id, leadIds[0] as number))).toBe('ok');
    expect(await pgCode(addRun(await addAutomation(), lead))).toBe('ok');
    // Depois que a participação termina, o lead pode entrar de novo.
    await t.db
      .updateTable('automation_runs')
      .set({ status: 'cancelled', cancelled_at: new Date(), cancel_reason: 'lead_replied' })
      .where('id', '=', first)
      .execute();
    expect(await pgCode(addRun(id, lead))).toBe('ok');
  });

  it('excluir o lead (LGPD) ou a automação leva as participações', async () => {
    const id = await addAutomation();
    const list = await seedList(t.db, { count: 1, createdBy: userId, phoneStart: 100 });
    const lead = list.leadIds[0] as number;
    await addRun(id, lead);
    expect(await countOf('automation_runs', 'lead_id', lead)).toBe(1);
    await t.db.deleteFrom('leads').where('id', '=', lead).execute();
    expect(await countOf('automation_runs', 'lead_id', lead)).toBe(0);

    await addRun(id, leadIds[0] as number);
    expect(await countOf('automation_runs', 'automation_id', id)).toBe(1);
    await t.db.deleteFrom('automations').where('id', '=', id).execute();
    expect(await countOf('automation_runs', 'automation_id', id)).toBe(0);
  });
});

describe('automation_step_runs', () => {
  async function newRun() {
    const automation = await addAutomation();
    const step = await addStep(automation, 1);
    const list = await seedList(t.db, { count: 1, createdBy: userId, phoneStart: 200 + seq });
    const run = await addRun(automation, list.leadIds[0] as number);
    return { automation, step, run };
  }

  it('FK: exige participação, etapa e mensagem que existam', async () => {
    const { run, step } = await newRun();
    expect(await pgCode(addStepRun(999_999, step))).toBe(FK);
    expect(await pgCode(addStepRun(run, 999_999))).toBe(FK);
    expect(await pgCode(addStepRun(run, step, { message_id: 999_999 }))).toBe(FK);
    expect(await pgCode(addStepRun(run, step))).toBe('ok');
  });

  it('nasce pendente, sem tentativas, sem erro e sem mensagem', async () => {
    const { run, step } = await newRun();
    const id = await addStepRun(run, step);
    const row = await t.db
      .selectFrom('automation_step_runs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'pending',
      attempts: 0,
      error: null,
      message_id: null,
      started_at: null,
      finished_at: null,
      step_id: step,
      automation_run_id: run,
    });
  });

  it('aceita todos os status do módulo, recusa desconhecidos e tentativas negativas', async () => {
    for (const status of AUTOMATION_STEP_RUN_STATUSES) {
      const { run, step } = await newRun();
      expect(await pgCode(addStepRun(run, step, { status })), status).toBe('ok');
    }
    const { run, step } = await newRun();
    const invalid = sql`INSERT INTO automation_step_runs (automation_run_id, step_id, scheduled_at, status)
      VALUES (${run}, ${step}, now(), 'sent')`;
    expect(await pgCode(invalid.execute(t.db))).toBe(CHECK);
    expect(await pgCode(addStepRun(run, step, { attempts: -1 }))).toBe(CHECK);
  });

  it('cada etapa roda uma vez por participação (novas tentativas somam em attempts)', async () => {
    const { automation, run, step } = await newRun();
    await addStepRun(run, step);
    expect(await pgCode(addStepRun(run, step))).toBe(UNIQUE);
    const second = await addStep(automation, 2);
    expect(await pgCode(addStepRun(run, second))).toBe('ok');
  });

  it('a mensagem enviada pela etapa fica ligada a ela; apagar a mensagem mantém o histórico', async () => {
    const { run, step } = await newRun();
    const messageId = await addMessage();
    const stepRun = await addStepRun(run, step, { status: 'completed', message_id: messageId, attempts: 1 });

    const joined = await t.db
      .selectFrom('automation_step_runs as sr')
      .innerJoin('wa_messages as m', 'm.id', 'sr.message_id')
      .select(['sr.id', 'm.text'])
      .where('sr.id', '=', stepRun)
      .executeTakeFirst();
    expect(joined).toEqual({ id: stepRun, text: 'Olá!' });

    await t.db.deleteFrom('wa_messages').where('id', '=', messageId).execute();
    const kept = await t.db
      .selectFrom('automation_step_runs')
      .select(['message_id', 'status', 'attempts'])
      .where('id', '=', stepRun)
      .executeTakeFirst();
    expect(kept).toEqual({ message_id: null, status: 'completed', attempts: 1 });
  });

  it('apagar a etapa mantém o histórico dela, sem o vínculo', async () => {
    const { run, step } = await newRun();
    const stepRun = await addStepRun(run, step, { status: 'completed' });
    await t.db.deleteFrom('automation_steps').where('id', '=', step).execute();
    const kept = await t.db
      .selectFrom('automation_step_runs')
      .select(['step_id', 'status'])
      .where('id', '=', stepRun)
      .executeTakeFirst();
    expect(kept).toEqual({ step_id: null, status: 'completed' });
  });

  it('apagar a participação, a automação ou o lead leva o histórico das etapas', async () => {
    const one = await newRun();
    const two = await newRun();
    const three = await newRun();
    await addStepRun(one.run, one.step);
    await addStepRun(two.run, two.step);
    await addStepRun(three.run, three.step);

    await t.db.deleteFrom('automation_runs').where('id', '=', one.run).execute();
    expect(await countOf('automation_step_runs', 'automation_run_id', one.run)).toBe(0);

    await t.db.deleteFrom('automations').where('id', '=', two.automation).execute();
    expect(await countOf('automation_step_runs', 'automation_run_id', two.run)).toBe(0);

    const lead = await t.db
      .selectFrom('automation_runs')
      .select('lead_id')
      .where('id', '=', three.run)
      .executeTakeFirstOrThrow();
    await t.db.deleteFrom('leads').where('id', '=', lead.lead_id).execute();
    expect(await countOf('automation_step_runs', 'automation_run_id', three.run)).toBe(0);
  });
});

describe('índices', () => {
  it('existem os índices que as consultas futuras vão usar', async () => {
    const r = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename LIKE 'automation%'`.execute(t.db);
    const names = r.rows.map((row) => row.indexname);
    for (const expected of [
      'automations_status_idx',
      'automations_created_by_idx',
      'automations_open_idx',
      'automations_name_key',
      'automation_steps_position_key',
      'automation_steps_audio_idx',
      'automation_runs_automation_idx',
      'automation_runs_lead_idx',
      'automation_runs_status_idx',
      'automation_runs_due_idx',
      'automation_runs_live_key',
      'automation_step_runs_run_idx',
      'automation_step_runs_step_idx',
      'automation_step_runs_message_idx',
      'automation_step_runs_due_idx',
      'automation_step_runs_once_key',
    ]) {
      expect(names, expected).toContain(expected);
    }
  });
});

describe('automation_steps.audio_id (migração 0009)', () => {
  async function addAudio(label: string): Promise<number> {
    const row = await t.db
      .insertInto('wa_audios')
      .values({ label, media_path: `audios/${label}.ogg`, media_mime: 'audio/ogg', bytes: 10 })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
  const audioOf = async (stepId: number) =>
    (
      await t.db
        .selectFrom('automation_steps')
        .select('audio_id')
        .where('id', '=', stepId)
        .executeTakeFirstOrThrow()
    ).audio_id;

  it('a etapa de áudio guarda o áudio da biblioteca; a de texto nasce sem áudio', async () => {
    const id = await addAutomation();
    const audioId = await addAudio('guardado');
    const step = await addStep(id, 1, { action_type: 'send_audio', message_text: null, audio_id: audioId });
    expect(await audioOf(step)).toBe(audioId);
    expect(await audioOf(await addStep(id, 2))).toBeNull();
  });

  it('FK: áudio que não existe na biblioteca é recusado', async () => {
    const id = await addAutomation();
    const ghost = addStep(id, 1, { action_type: 'send_audio', message_text: null, audio_id: 999_999 });
    expect(await pgCode(ghost)).toBe(FK);
  });

  it('só a etapa de áudio pode ter áudio', async () => {
    const id = await addAutomation();
    const audioId = await addAudio('so-de-audio');
    expect(await pgCode(addStep(id, 1, { action_type: 'send_text', audio_id: audioId }))).toBe(CHECK);
    const step = await addStep(id, 2);
    const setAudio = t.db.updateTable('automation_steps').set({ audio_id: audioId }).where('id', '=', step);
    expect(await pgCode(setAudio.execute())).toBe(CHECK);
  });

  it('excluir o áudio deixa a etapa sem áudio, mas não apaga a etapa nem a automação', async () => {
    const id = await addAutomation();
    const audioId = await addAudio('vai-sumir');
    const step = await addStep(id, 1, { action_type: 'send_audio', message_text: null, audio_id: audioId });
    await t.db.deleteFrom('wa_audios').where('id', '=', audioId).execute();
    expect(await audioOf(step)).toBeNull();
    expect(await countOf('automation_steps', 'automation_id', id)).toBe(1);
    const automation = await t.db
      .selectFrom('automations')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    expect(automation).toEqual({ id });
  });

  it('a migração desfaz e refaz a coluna', async () => {
    const own = await createTestDb();
    try {
      const hasColumn = async () => {
        const r = await sql<{ n: number }>`
          SELECT count(*) AS n FROM information_schema.columns
          WHERE table_name = 'automation_steps' AND column_name = 'audio_id'`.execute(own.db);
        return r.rows[0]?.n ?? 0;
      };
      expect(await hasColumn()).toBe(1);
      await audioMigration.down(own.db as unknown as Kysely<unknown>);
      expect(await hasColumn()).toBe(0);
      await audioMigration.up(own.db as unknown as Kysely<unknown>);
      expect(await hasColumn()).toBe(1);
    } finally {
      await own.drop();
    }
  });
});

describe('migração 0008', () => {
  it('desfaz e refaz sem erro, e as tabelas voltam vazias', async () => {
    const own = await createTestDb();
    try {
      const exists = async () => {
        const r = await sql<{ n: number }>`
          SELECT count(*) AS n FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name LIKE 'automation%'`.execute(own.db);
        return r.rows[0]?.n ?? 0;
      };
      // Cinco tabelas: as quatro da 0008 e as campanhas (0012). As migrações mais novas saem primeiro.
      expect(await exists()).toBe(5);
      await campaignsMigration.down(own.db as unknown as Kysely<unknown>);
      await raffleMigration.down(own.db as unknown as Kysely<unknown>);
      expect(await exists()).toBe(4);
      await migration.down(own.db as unknown as Kysely<unknown>);
      expect(await exists()).toBe(0);
      await migration.up(own.db as unknown as Kysely<unknown>);
      expect(await exists()).toBe(4);
      expect(await own.db.selectFrom('automations').select('id').execute()).toEqual([]);
    } finally {
      await own.drop();
    }
  });
});
