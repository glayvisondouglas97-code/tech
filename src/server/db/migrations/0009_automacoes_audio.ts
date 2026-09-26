import { type Kysely, sql } from 'kysely';

/**
 * A etapa que envia áudio guarda qual áudio da biblioteca do Chamar (wa_audios) ela usa.
 * Se o áudio for excluído, a etapa fica sem áudio (SET NULL) em vez de sumir: a automação continua lá e o
 * gestor escolhe outro. Ninguém consegue ativar uma automação com etapa sem áudio (regra no serviço).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_steps ADD COLUMN audio_id int REFERENCES wa_audios(id) ON DELETE SET NULL`.execute(
    db,
  );
  // Só a etapa de áudio tem áudio. (Não exige áudio em "send_audio": o SET NULL acima o esvazia.)
  await sql`ALTER TABLE automation_steps ADD CONSTRAINT automation_steps_audio_check
    CHECK (action_type = 'send_audio' OR audio_id IS NULL)`.execute(db);
  // Excluir um áudio procura as etapas que o usam.
  await sql`CREATE INDEX automation_steps_audio_idx ON automation_steps (audio_id) WHERE audio_id IS NOT NULL`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_steps DROP COLUMN IF EXISTS audio_id`.execute(db);
}
