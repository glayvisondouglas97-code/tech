/**
 * Cria o dono do sistema (acesso master) ou recupera o acesso de um dono.
 *
 *   npm run criar-admin -- --nome "Maria Gestora" --email maria@empresa.com.br
 *
 * A senha é gerada e mostrada uma vez na tela (troque depois em "Minha conta").
 * Para escolher a senha: --senha "uma senha forte". Se o e-mail já existir, a senha é
 * redefinida e a pessoa volta a ser administradora ativa.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { hashPassword, passwordProblem } from '../auth/password';
import { destroyUserSessions } from '../auth/sessions';
import { createDb, createPool } from '../db';
import { migrateToLatest } from '../db/migrate';
import { audit } from '../lib/audit';
import { createAdminDirect } from '../modules/users/service';
import { scriptDatabase } from './script-db';

const { values } = parseArgs({
  options: { nome: { type: 'string' }, email: { type: 'string' }, senha: { type: 'string' } },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const email = values.email?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  fail('Uso: npm run criar-admin -- --nome "Seu Nome" --email voce@empresa.com.br [--senha "..."]');
}
const generated = !values.senha;
const password = values.senha ?? randomBytes(9).toString('base64url');
const problem = passwordProblem(password, { email });
if (problem) fail(problem);

const target = await scriptDatabase();
const db = createDb(createPool(target.url, 2));
try {
  await migrateToLatest(db);
  const existing = await db
    .selectFrom('users')
    .select(['id', 'name'])
    .where(sql`lower(email)`, '=', email)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable('users')
      .set({
        password_hash: await hashPassword(password),
        role: 'dono',
        active: true,
        password_changed_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where('id', '=', existing.id)
      .execute();
    await destroyUserSessions(db, existing.id);
    await audit(db, {
      userId: existing.id,
      action: 'senha_redefinida_por_comando',
      entity: 'usuario',
      entityId: existing.id,
    });
    console.log(`\nAcesso de ${existing.name} (${email}) redefinido como dono (acesso master).`);
  } else {
    const name = values.nome?.trim() || email.split('@')[0] || 'Administrador';
    await createAdminDirect(db, { name, email, password });
    console.log(`\nDono criado (acesso master): ${name} (${email}).`);
  }
  if (generated)
    console.log(
      `Senha: ${password}\nGuarde agora; ela não será mostrada de novo. Troque em "Minha conta" depois de entrar.\n`,
    );
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.destroy();
  await target.done();
}
