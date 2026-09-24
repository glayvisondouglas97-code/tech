// Rotas de login (/api/auth) e de gerenciamento da equipe (/api/users, só administradores).
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import {
  clearFailures,
  createSession,
  currentUser,
  destroySession,
  destroyUserSessions,
  hashPassword,
  isBlocked,
  normalizeEmail,
  passwordProblem,
  recordFailure,
  requireAdmin,
  requireAuth,
  temporaryPassword,
  userDto,
  verifyPassword,
} from './auth.ts';
import { prisma } from './db.ts';
import { disconnectUser } from './realtime.ts';

const fail = (res: Response, status: number, error: string) => res.status(status).json({ error });

// Hash de uma senha qualquer: quando o e-mail não existe, o login gasta o mesmo tempo (não revela quem tem conta).
const dummyHash = hashPassword('senha-de-comparacao');

export const authRouter = Router();
authRouter.use(express.json({ limit: '10kb' }));

authRouter.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const keys = [`ip:${req.ip}`, `email:${email}`];
  if (isBlocked(keys)) return fail(res, 429, 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');

  const user = email ? await prisma.user.findUnique({ where: { email } }) : null;
  const valid = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
  if (!user || !valid || !user.active) {
    recordFailure(keys);
    return fail(res, 401, 'E-mail ou senha incorretos');
  }
  clearFailures(keys);
  await createSession(req, res, user.id);
  res.json(userDto(user));
});

authRouter.post('/logout', async (req, res) => {
  await destroySession(req, res);
  res.sendStatus(204);
});

authRouter.get('/me', requireAuth, (_req, res) => {
  res.json(userDto(currentUser(res)));
});

// Trocar a própria senha. Os outros logins da pessoa (outros computadores) são encerrados.
authRouter.post('/password', requireAuth, async (req, res) => {
  const user = currentUser(res);
  if (!(await verifyPassword(String(req.body?.currentPassword ?? ''), user.passwordHash))) {
    return fail(res, 400, 'A senha atual está incorreta');
  }
  const problem = passwordProblem(req.body?.newPassword);
  if (problem) return fail(res, 400, problem);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(req.body.newPassword) } });
  await destroyUserSessions(user.id, req.headers.cookie);
  res.sendStatus(204);
});

export const usersRouter = Router();
usersRouter.use(requireAdmin);

usersRouter.get('/', async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
  res.json(users.map(userDto));
});

// Cria o acesso de alguém da equipe com uma senha provisória (mostrada uma única vez para quem criou).
usersRouter.post('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
  const email = normalizeEmail(req.body?.email);
  if (!name) return fail(res, 400, 'Informe o nome');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'E-mail inválido');
  if (await prisma.user.findUnique({ where: { email } })) return fail(res, 409, 'Já existe um usuário com esse e-mail');
  const password = temporaryPassword();
  const user = await prisma.user.create({
    data: { name, email, isAdmin: req.body?.isAdmin === true, passwordHash: await hashPassword(password) },
  });
  res.status(201).json({ user: userDto(user), temporaryPassword: password });
});

// Ativar/desativar e dar/tirar acesso de administrador. Ninguém pode desativar nem rebaixar a si mesmo.
usersRouter.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return fail(res, 404, 'Usuário não encontrado');
  const data: { active?: boolean; isAdmin?: boolean } = {};
  if (typeof req.body?.active === 'boolean') data.active = req.body.active;
  if (typeof req.body?.isAdmin === 'boolean') data.isAdmin = req.body.isAdmin;
  if (id === currentUser(res).id && (data.active === false || data.isAdmin === false)) {
    return fail(res, 400, 'Você não pode desativar nem tirar o próprio acesso de administrador');
  }
  const user = await prisma.user.update({ where: { id }, data });
  if (data.active === false) {
    await destroyUserSessions(id);
    await disconnectUser(id);
  }
  res.json(userDto(user));
});

// Gera uma senha provisória nova (ex.: a pessoa esqueceu a dela) e encerra os logins dela.
usersRouter.post('/:id/reset-password', async (req, res) => {
  const id = Number(req.params.id);
  if (id === currentUser(res).id) return fail(res, 400, 'Para trocar a sua própria senha, use "Minha senha"');
  if (!(await prisma.user.findUnique({ where: { id } }))) return fail(res, 404, 'Usuário não encontrado');
  const password = temporaryPassword();
  await prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(password) } });
  await destroyUserSessions(id);
  await disconnectUser(id);
  res.json({ temporaryPassword: password });
});

export function accountsErrorHandler(error: Error, _req: Request, res: Response, _next: NextFunction): void {
  console.error('[login]', error);
  res.status(500).json({ error: 'Erro interno' });
}
