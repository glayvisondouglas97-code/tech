import { type Kysely, sql } from 'kysely';

/**
 * Biblioteca de áudios do "Chamar": várias versões da mesma mensagem, gravadas antes. Quando o atendente
 * escolhe o número no botão Chamar, o sistema sorteia uma delas e envia como mensagem de voz para o lead.
 * O arquivo fica na pasta de mídias (audios/<id>.<ext>), nunca no banco.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE wa_audios (
      id serial PRIMARY KEY,
      label text NOT NULL,
      media_path text NOT NULL,
      media_mime text NOT NULL,
      seconds int,
      bytes int NOT NULL,
      active boolean NOT NULL DEFAULT true,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  // Sorteio só entre os ativos.
  await sql`CREATE INDEX wa_audios_active_idx ON wa_audios (active) WHERE active`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS wa_audios`.execute(db);
}
