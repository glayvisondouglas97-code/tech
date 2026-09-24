import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import type { InviteLink, TeamMember, UserAdmin } from '../../../shared/api';
import { manageableRoles, ROLE_LABELS, ROLES, type Role } from '../../../shared/roles';
import { hashPassword, passwordProblem } from '../../auth/password';
import { type AuthUser, destroyUserSessions } from '../../auth/sessions';
import { createPasswordLink } from '../../auth/tokens';
import type { Database } from '../../db/schema';
import { audit } from '../../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { spDayStart } from '../../lib/time';
import { releaseLeads } from '../leads/service';
import { refreshUserAccess } from '../whatsapp/realtime';

type Db = Kysely<Database>;

const baseUser = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  role: z.enum(ROLES),
});

/** Senha definida pelo gestor. Vazia = a pessoa cria a própria senha por um link de convite. */
export const userInputSchema = baseUser.extend({
  password: z.string().max(200).optional(),
});

export const passwordSetSchema = z.object({ password: z.string().max(200) });

export const userUpdateSchema = baseUser.partial().extend({
  /** Limite diário de leads da pessoa. null = usa o padrão da empresa; 0 = sem limite. */
  dailyPullLimit: z.number().int().min(0).max(100_000).nullable().optional(),
});

async function emailTaken(db: Db, email: string, exceptId?: string) {
  let q = db.selectFrom('users').select('id').where(sql`lower(email)`, '=', email.toLowerCase());
  if (exceptId) q = q.where('id', '<>', exceptId);
  return !!(await q.executeTakeFirst());
}

async function activeOwners(db: Db): Promise<number> {
  const r = await db
    .selectFrom('users')
    .select(sql<number>`count(*)`.as('n'))
    .where('role', '=', 'dono')
    .where('active', '=', true)
    .where('password_hash', 'is not', null)
    .executeTakeFirstOrThrow();
  return r.n;
}

/** Hierarquia: o administrador só mexe em supervisores e atendentes; o dono mexe em todos. */
function assertCanManage(actor: AuthUser, targetRole: Role, action = 'gerenciar') {
  if (!manageableRoles(actor.role).includes(targetRole)) {
    throw forbidden(
      `Só o dono pode ${action} ${targetRole === 'dono' ? 'donos' : 'administradores'} (${ROLE_LABELS[targetRole]}).`,
    );
  }
}

async function loadTarget(db: Db, id: string) {
  const user = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  if (!user) throw notFound('Usuário não encontrado.');
  return user;
}

export async function listUsers(db: Db): Promise<UserAdmin[]> {
  const rows = await db
    .selectFrom('users as u')
    .select([
      'u.id',
      'u.name',
      'u.email',
      'u.role',
      'u.active',
      'u.created_at',
      'u.last_login_at',
      'u.password_hash',
      'u.daily_pull_limit',
      sql<number>`(SELECT count(*) FROM leads l WHERE l.status = 'pendente' AND l.assigned_to = u.id)`.as(
        'queue',
      ),
      sql<number>`(SELECT count(*) FROM lead_events e WHERE e.user_id = u.id AND e.type = 'pegou'
        AND e.created_at >= ${spDayStart(0)})`.as('pulled_today'),
    ])
    .orderBy('u.active', 'desc')
    .orderBy('u.name')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    active: r.active,
    createdAt: r.created_at.toISOString(),
    lastLoginAt: r.last_login_at?.toISOString() ?? null,
    pendingInvite: !r.password_hash,
    queue: r.queue,
    dailyPullLimit: r.daily_pull_limit,
    pulledToday: r.pulled_today,
  }));
}

export async function listTeam(db: Db): Promise<TeamMember[]> {
  return db
    .selectFrom('users')
    .select(['id', 'name', 'role'])
    .where('active', '=', true)
    .orderBy('name')
    .execute();
}

function checkPassword(password: string, who: { email: string; name: string }) {
  const problem = passwordProblem(password, who);
  if (problem) throw badRequest(problem);
}

/**
 * Cria a pessoa. Com senha: já entra com e-mail e senha definidos pelo gestor.
 * Sem senha: devolve um link de convite para ela criar a própria senha.
 */
export async function createUser(
  db: Db,
  actor: AuthUser,
  input: z.infer<typeof userInputSchema>,
  appUrl: string,
  ip: string | null,
): Promise<{ id: string; invite: InviteLink | null }> {
  assertCanManage(actor, input.role, 'cadastrar');
  const password = input.password || null;
  if (password) checkPassword(password, input);
  if (await emailTaken(db, input.email)) throw conflict('Já existe alguém com esse e-mail na equipe.');
  const hash = password ? await hashPassword(password) : null;
  return db.transaction().execute(async (trx) => {
    const u = await trx
      .insertInto('users')
      .values({
        name: input.name,
        email: input.email,
        role: input.role,
        password_hash: hash,
        password_changed_at: hash ? new Date() : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const invite = hash ? null : await createPasswordLink(trx, u.id, 'convite', actor.id, appUrl);
    await audit(trx, {
      userId: actor.id,
      action: 'criou_usuario',
      entity: 'usuario',
      entityId: u.id,
      details: { nome: input.name, papel: input.role, acesso: hash ? 'senha definida' : 'convite' },
      ip,
    });
    return { id: u.id, invite };
  });
}

export async function updateUser(
  db: Db,
  actor: AuthUser,
  id: string,
  input: z.infer<typeof userUpdateSchema>,
  ip: string | null,
): Promise<void> {
  const user = await loadTarget(db, id);
  assertCanManage(actor, user.role, 'alterar');
  if (input.role) assertCanManage(actor, input.role, 'promover para');
  if (input.email && (await emailTaken(db, input.email, id)))
    throw conflict('Já existe alguém com esse e-mail.');
  if (
    input.role &&
    input.role !== 'dono' &&
    user.role === 'dono' &&
    user.active &&
    (await activeOwners(db)) <= 1
  ) {
    throw conflict('Esta é a única pessoa dona. Cadastre outro dono antes de mudar o papel dela.');
  }
  const { dailyPullLimit, ...rest } = input;
  await db
    .updateTable('users')
    .set({
      ...rest,
      ...(dailyPullLimit !== undefined ? { daily_pull_limit: dailyPullLimit } : {}),
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .execute();
  // Mudou o papel: as sessões abertas recarregam o papel novo na próxima requisição (vem do banco),
  // e o tempo real passa a mandar só o que o papel novo pode ver (conversas de WhatsApp).
  if (input.role && input.role !== user.role) refreshUserAccess(id, input.role);
  await audit(db, {
    userId: actor.id,
    action: 'alterou_usuario',
    entity: 'usuario',
    entityId: id,
    details: {
      pessoa: user.name,
      ...(input.name && input.name !== user.name ? { nome: input.name } : {}),
      ...(input.role && input.role !== user.role ? { papel: `${user.role} → ${input.role}` } : {}),
      ...(input.email && input.email !== user.email ? { email_alterado: true } : {}),
      ...(dailyPullLimit !== undefined && dailyPullLimit !== user.daily_pull_limit
        ? { limite_diario: dailyPullLimit ?? 'padrão' }
        : {}),
    },
    ip,
  });
}

/** Desativar: tira o acesso na hora, encerra as sessões e devolve os leads pendentes para a fila livre. */
export async function setActive(
  db: Db,
  actor: AuthUser,
  id: string,
  active: boolean,
  ip: string | null,
): Promise<{ released: number }> {
  if (id === actor.id && !active) throw badRequest('Você não pode desativar o próprio acesso.');
  const user = await loadTarget(db, id);
  assertCanManage(actor, user.role, active ? 'reativar' : 'desativar');
  if (!active && user.role === 'dono' && user.active && (await activeOwners(db)) <= 1) {
    throw conflict('Esta é a única pessoa dona ativa. Cadastre outro dono antes.');
  }
  await db.updateTable('users').set({ active, updated_at: sql`now()` }).where('id', '=', id).execute();
  let released = 0;
  if (!active) {
    await destroyUserSessions(db, id);
    await db
      .updateTable('password_tokens')
      .set({ used_at: sql`now()` })
      .where('user_id', '=', id)
      .where('used_at', 'is', null)
      .execute();
    released = await releaseLeads(db, actor, { userId: id, reason: 'usuário desativado' });
  }
  await audit(db, {
    userId: actor.id,
    action: active ? 'reativou_usuario' : 'desativou_usuario',
    entity: 'usuario',
    entityId: id,
    details: { nome: user.name, leads_devolvidos: released },
    ip,
  });
  return { released };
}

/** O gestor define uma senha nova para a pessoa: as sessões abertas dela caem e os links pendentes deixam de valer. */
export async function setPassword(
  db: Db,
  actor: AuthUser,
  id: string,
  password: string,
  ip: string | null,
): Promise<void> {
  if (id === actor.id) throw badRequest('Para trocar a sua própria senha, use Minha conta.');
  const user = await loadTarget(db, id);
  assertCanManage(actor, user.role, 'definir a senha de');
  if (!user.active) throw conflict('Reative a pessoa antes de definir uma senha.');
  checkPassword(password, user);
  const hash = await hashPassword(password);
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('users')
      .set({ password_hash: hash, password_changed_at: sql`now()`, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
    await trx
      .updateTable('password_tokens')
      .set({ used_at: sql`now()` })
      .where('user_id', '=', id)
      .where('used_at', 'is', null)
      .execute();
    await audit(trx, {
      userId: actor.id,
      action: 'definiu_senha',
      entity: 'usuario',
      entityId: id,
      details: { nome: user.name },
      ip,
    });
  });
  await destroyUserSessions(db, id);
}

export async function resetLink(
  db: Db,
  actor: AuthUser,
  id: string,
  appUrl: string,
  ip: string | null,
): Promise<InviteLink> {
  const user = await loadTarget(db, id);
  assertCanManage(actor, user.role, 'gerar link de senha para');
  if (!user.active) throw conflict('Reative a pessoa antes de gerar um link.');
  const link = await createPasswordLink(
    db,
    id,
    user.password_hash ? 'redefinir' : 'convite',
    actor.id,
    appUrl,
  );
  await audit(db, {
    userId: actor.id,
    action: 'gerou_link_senha',
    entity: 'usuario',
    entityId: id,
    details: { nome: user.name },
    ip,
  });
  return link;
}

/** Usado pelo script e pelo "primeiro acesso": cria um dono (acesso master). */
export async function createAdminDirect(
  db: Db,
  input: { name: string; email: string; password: string },
): Promise<string> {
  if (await emailTaken(db, input.email)) throw conflict('Já existe alguém com esse e-mail.');
  const u = await db
    .insertInto('users')
    .values({
      name: input.name,
      email: input.email.toLowerCase(),
      role: 'dono',
      password_hash: await hashPassword(input.password),
      password_changed_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await audit(db, { userId: u.id, action: 'criou_primeiro_admin', entity: 'usuario', entityId: u.id });
  return u.id;
}
