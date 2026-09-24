import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserAdmin } from '../../src/shared/api';
import { Client, type Client as ClientT, createTestApp, createUser, loginAs, type TestApp } from '../helpers';

let t: TestApp;
let dono: ClientT;
let admin: ClientT;
let ids: { dono: string; admin: string };

beforeAll(async () => {
  t = await createTestApp();
  const d = await createUser(t.db, { name: 'Dona', role: 'dono' });
  const a = await createUser(t.db, { name: 'Admin', role: 'admin' });
  ids = { dono: d.id, admin: a.id };
  dono = await loginAs(t.app, d);
  admin = await loginAs(t.app, a);
});
afterAll(async () => t.close());

describe('painel de usuários: senha definida pelo gestor', () => {
  it('dono cria um administrador com e-mail e senha, e ele já entra', async () => {
    const r = await dono.post('/api/users', {
      name: 'Novo Admin',
      email: 'Novo.Admin@Empresa.com',
      role: 'admin',
      password: 'Senha-Forte-2026',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().invite).toBeNull();
    const c = new Client(t.app);
    expect((await c.login('novo.admin@empresa.com', 'Senha-Forte-2026')).statusCode).toBe(200);
    expect((await c.get('/api/auth/me')).json().user.role).toBe('admin');
  });

  it('administrador cria atendente com senha; senha fraca é recusada', async () => {
    const weak = await admin.post('/api/users', {
      name: 'Fraca',
      email: 'fraca@empresa.com',
      role: 'atendente',
      password: 'aaaaaaaa',
    });
    expect(weak.statusCode).toBe(400);
    const r = await admin.post('/api/users', {
      name: 'Ana Nova',
      email: 'ana.nova@empresa.com',
      role: 'atendente',
      password: 'Ana-senha-123',
    });
    expect(r.statusCode).toBe(200);
    const list: UserAdmin[] = (await admin.get('/api/users')).json();
    expect(list.find((u) => u.email === 'ana.nova@empresa.com')).toMatchObject({
      role: 'atendente',
      pendingInvite: false,
    });
  });

  it('sem senha continua gerando convite', async () => {
    const r = await admin.post('/api/users', {
      name: 'Convidado',
      email: 'conv@empresa.com',
      role: 'supervisor',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().invite.url).toMatch(/\/definir-senha#token=/);
  });

  it('gestor define nova senha: a sessão antiga cai e só a senha nova funciona', async () => {
    const ana = new Client(t.app);
    expect((await ana.login('ana.nova@empresa.com', 'Ana-senha-123')).statusCode).toBe(200);
    const list: UserAdmin[] = (await admin.get('/api/users')).json();
    const id = list.find((u) => u.email === 'ana.nova@empresa.com')?.id as string;
    expect((await admin.post(`/api/users/${id}/password`, { password: 'Nova-senha-456' })).statusCode).toBe(
      200,
    );
    expect((await ana.get('/api/queue/stats')).statusCode).toBe(401);
    expect((await new Client(t.app).login('ana.nova@empresa.com', 'Ana-senha-123')).statusCode).toBe(401);
    expect((await new Client(t.app).login('ana.nova@empresa.com', 'Nova-senha-456')).statusCode).toBe(200);
    const row = await t.db
      .selectFrom('audit_log')
      .select('details')
      .where('action', '=', 'definiu_senha')
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row.details)).not.toContain('Nova-senha-456');
  });

  it('respeita a hierarquia e não troca a própria senha por aqui', async () => {
    expect(
      (await admin.post(`/api/users/${ids.dono}/password`, { password: 'Outra-senha-789' })).statusCode,
    ).toBe(403);
    expect(
      (await admin.post(`/api/users/${ids.admin}/password`, { password: 'Outra-senha-789' })).statusCode,
    ).toBe(400);
    expect(
      (
        await admin.post('/api/users', {
          name: 'X',
          email: 'x@empresa.com',
          role: 'dono',
          password: 'Senha-Forte-1',
        })
      ).statusCode,
    ).toBe(403);
  });
});
