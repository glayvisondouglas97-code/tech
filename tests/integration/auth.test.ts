import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, createUser, loginAs, TEST_PASSWORD, type TestApp } from '../helpers';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ env: { SETUP_TOKEN: 'codigo-secreto-de-setup' } });
});
afterAll(async () => t.close());

describe('primeiro acesso', () => {
  it('cria o primeiro administrador com o código e depois se fecha', async () => {
    const c = new Client(t.app);
    expect((await c.get('/api/setup')).json()).toEqual({ needed: true, enabled: true });
    const wrong = await c.post('/api/setup', {
      setupToken: 'errado',
      name: 'Dona',
      email: 'dona@empresa.com',
      password: 'senha-muito-boa',
    });
    expect(wrong.statusCode).toBe(403);
    const ok = await c.post('/api/setup', {
      setupToken: 'codigo-secreto-de-setup',
      name: 'Dona',
      email: 'Dona@Empresa.com',
      password: 'senha-muito-boa',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user).toMatchObject({ name: 'Dona', email: 'dona@empresa.com', role: 'dono' });
    const again = await c.post('/api/setup', {
      setupToken: 'codigo-secreto-de-setup',
      name: 'Outra',
      email: 'outra@empresa.com',
      password: 'senha-muito-boa',
    });
    expect(again.statusCode).toBe(409);
    expect((await c.get('/api/setup')).json().needed).toBe(false);
  });
});

describe('login e sessão', () => {
  it('entra, lê /me e sai', async () => {
    const u = await createUser(t.db, { name: 'Ana', role: 'atendente' });
    const c = new Client(t.app);
    expect((await c.get('/api/auth/me')).statusCode).toBe(401);
    const r = await c.login(u.email.toUpperCase());
    expect(r.statusCode).toBe(200);
    const cookie = r.cookies.find((x) => x.name === 'cl_sid');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    const me = await c.get('/api/auth/me');
    expect(me.json().user).toMatchObject({ id: u.id, role: 'atendente' });
    expect((await c.post('/api/auth/logout')).statusCode).toBe(200);
    expect((await c.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('senha errada dá mensagem genérica e o banco guarda só o hash', async () => {
    const u = await createUser(t.db, { name: 'Bia', role: 'atendente' });
    const r = await new Client(t.app).login(u.email, 'errada-errada');
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('E-mail ou senha incorretos.');
    const row = await t.db
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', u.id)
      .executeTakeFirstOrThrow();
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    const sessions = await t.db.selectFrom('sessions').select('id').execute();
    for (const s of sessions) expect(s.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('bloqueia o e-mail depois de 5 senhas erradas (rate limit)', async () => {
    const u = await createUser(t.db, { name: 'Caio', role: 'atendente' });
    const c = new Client(t.app);
    for (let i = 0; i < 5; i++) expect((await c.login(u.email, 'errada-errada')).statusCode).toBe(401);
    const blocked = await c.login(u.email, TEST_PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatch(/Muitas tentativas/);
  });

  it('limita tentativas de login por IP', async () => {
    const small = await createTestApp({ app: { loginAttemptsPerIp: 3 } });
    try {
      const c = new Client(small.app);
      const codes = [];
      for (let i = 0; i < 4; i++)
        codes.push((await c.login(`ninguem${i}@x.com`, 'qualquer-coisa')).statusCode);
      expect(codes).toEqual([401, 401, 401, 429]);
    } finally {
      await small.close();
    }
  });

  it('exige o token CSRF em requisições que alteram dados', async () => {
    const u = await createUser(t.db, { name: 'Davi', role: 'atendente' });
    const c = await loginAs(t.app, u);
    const noToken = await c.request('POST', '/api/queue/pull', {}, { 'x-csrf-token': '' });
    expect(noToken.statusCode).toBe(403);
    const wrongOrigin = await c.request(
      'POST',
      '/api/queue/pull',
      {},
      { origin: 'https://site-malicioso.com' },
    );
    expect(wrongOrigin.statusCode).toBe(403);
    const ok = await c.post('/api/queue/pull');
    expect(ok.statusCode).toBe(200);
  });

  it('usuário desativado perde a sessão na hora e não entra mais', async () => {
    const admin = await createUser(t.db, { name: 'Gestor', role: 'admin' });
    const u = await createUser(t.db, { name: 'Edu', role: 'atendente' });
    const ca = await loginAs(t.app, admin);
    const cu = await loginAs(t.app, u);
    expect((await cu.get('/api/queue/stats')).statusCode).toBe(200);
    expect((await ca.post(`/api/users/${u.id}/active`, { active: false })).statusCode).toBe(200);
    expect((await cu.get('/api/queue/stats')).statusCode).toBe(401);
    const again = await new Client(t.app).login(u.email);
    expect(again.statusCode).toBe(403);
  });
});

describe('convite e senha', () => {
  it('gestor convida, atendente define a senha pelo link (uma vez só) e entra', async () => {
    const admin = await createUser(t.db, { name: 'Gestora', role: 'admin' });
    const ca = await loginAs(t.app, admin);
    const created = await ca.post('/api/users', {
      name: 'Nova Atendente',
      email: 'nova@empresa.com',
      role: 'atendente',
    });
    expect(created.statusCode).toBe(200);
    const url: string = created.json().invite.url;
    expect(url).toMatch(/^http:\/\/localhost:5173\/definir-senha#token=/);
    const token = url.split('#token=')[1] as string;

    const anon = new Client(t.app);
    expect((await anon.login('nova@empresa.com', 'qualquer')).statusCode).toBe(401);
    const info = await anon.post('/api/auth/token/info', { token });
    expect(info.json()).toMatchObject({ purpose: 'convite', name: 'Nova Atendente' });
    expect((await anon.post('/api/auth/token/use', { token, password: '123' })).statusCode).toBe(400);
    const used = await anon.post('/api/auth/token/use', { token, password: 'minha-senha-nova' });
    expect(used.statusCode).toBe(200);
    expect(used.json().user.email).toBe('nova@empresa.com');
    expect((await anon.post('/api/auth/token/use', { token, password: 'outra-senha-nova' })).statusCode).toBe(
      400,
    );
    expect((await new Client(t.app).login('nova@empresa.com', 'minha-senha-nova')).statusCode).toBe(200);
  });

  it('troca a própria senha conferindo a atual', async () => {
    const u = await createUser(t.db, { name: 'Fabi', role: 'atendente' });
    const c = await loginAs(t.app, u);
    expect(
      (await c.post('/api/auth/password', { currentPassword: 'errada', newPassword: 'nova-senha-123' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await c.post('/api/auth/password', { currentPassword: TEST_PASSWORD, newPassword: '12345678' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await c.post('/api/auth/password', { currentPassword: TEST_PASSWORD, newPassword: 'nova-senha-123' }))
        .statusCode,
    ).toBe(200);
    expect((await new Client(t.app).login(u.email, 'nova-senha-123')).statusCode).toBe(200);
  });

  it('não deixa desativar nem rebaixar o último administrador', async () => {
    const fresh = await createTestApp();
    try {
      const admin = await createUser(fresh.db, { name: 'Única', role: 'dono' });
      const other = await createUser(fresh.db, { name: 'Outro', role: 'atendente' });
      const c = await loginAs(fresh.app, admin);
      expect((await c.post(`/api/users/${admin.id}/active`, { active: false })).statusCode).toBe(400);
      expect((await c.patch(`/api/users/${admin.id}`, { role: 'atendente' })).statusCode).toBe(409);
      expect((await c.patch(`/api/users/${other.id}`, { role: 'supervisor' })).statusCode).toBe(200);
    } finally {
      await fresh.close();
    }
  });

  it('registra login e ações sensíveis na auditoria', async () => {
    const rows = await t.db.selectFrom('audit_log').select('action').execute();
    const actions = new Set(rows.map((r) => r.action));
    for (const a of [
      'login',
      'login_falhou',
      'logout',
      'criou_usuario',
      'aceitou_convite',
      'desativou_usuario',
      'trocou_senha',
    ]) {
      expect(actions.has(a), a).toBe(true);
    }
  });
});
