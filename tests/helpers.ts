import { randomBytes } from 'node:crypto';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import pg from 'pg';
import { inject } from 'vitest';
import { type AppOptions, buildApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth/password';
import { type Config, loadConfig } from '../src/server/config';
import { createDb, createPool, type Db } from '../src/server/db';
import type { Role } from '../src/shared/roles';
import { normalizeText } from '../src/shared/text';

const TEMPLATE_DB = 'chamador_template';

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export interface TestDb {
  db: Db;
  url: string;
  drop: () => Promise<void>;
}

/** Banco novo (cópia do modelo já migrado) para um arquivo de teste. */
export async function createTestDb(): Promise<TestDb> {
  const base = inject('dbServerUrl');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  for (let i = 0; ; i++) {
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
      break;
    } catch (err) {
      // Outro arquivo pode estar copiando o modelo ao mesmo tempo.
      if (i > 20) throw err;
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    }
  }
  await admin.end();
  const url = withDatabase(base, name);
  const db = createDb(createPool(url, 30));
  return {
    db,
    url,
    drop: async () => {
      await db.destroy();
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export function testConfig(url: string, extra: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    APP_URL: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
    JOBS_ENABLED: 'false',
    MIGRATE_ON_START: 'false',
    ...extra,
  });
}

export interface TestApp extends TestDb {
  app: FastifyInstance;
  close: () => Promise<void>;
}

export async function createTestApp(
  opts: { env?: Record<string, string>; app?: AppOptions } = {},
): Promise<TestApp> {
  const t = await createTestDb();
  const app = await buildApp(t.db, testConfig(t.url, opts.env), {
    logger: false,
    loginAttemptsPerIp: 1000,
    requestsPerMinute: 100_000,
    ...opts.app,
  });
  await app.ready();
  return {
    ...t,
    app,
    close: async () => {
      await app.close();
      await t.drop();
    },
  };
}

export const TEST_PASSWORD = 'senha-de-teste-123';

let passwordHash: Promise<string> | null = null;

export async function createUser(
  db: Db,
  input: { name: string; role: Role; email?: string; active?: boolean },
): Promise<{ id: string; name: string; email: string; role: Role }> {
  passwordHash ??= hashPassword(TEST_PASSWORD);
  const email =
    input.email ??
    `${normalizeText(input.name).replace(/\W+/g, '.')}.${randomBytes(3).toString('hex')}@teste.com`;
  const u = await db
    .insertInto('users')
    .values({
      name: input.name,
      email,
      role: input.role,
      password_hash: await passwordHash,
      active: input.active ?? true,
    })
    .returning(['id', 'name', 'email', 'role'])
    .executeTakeFirstOrThrow();
  return u;
}

/** Cliente HTTP que guarda o cookie de sessão e manda o token CSRF, como o navegador. */
export class Client {
  cookie = '';
  csrf = '';
  constructor(private readonly app: FastifyInstance) {}

  async login(email: string, password = TEST_PASSWORD): Promise<LightMyRequestResponse> {
    const r = await this.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    this.take(r);
    if (r.statusCode === 200) this.csrf = r.json().csrfToken;
    return r;
  }

  take(r: LightMyRequestResponse) {
    const c = r.cookies.find((x) => x.name === 'cl_sid');
    if (c) this.cookie = c.value ? `cl_sid=${c.value}` : '';
  }

  request(
    method: InjectOptions['method'],
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) {
    return this.app.inject({
      method,
      url,
      payload: payload as InjectOptions['payload'],
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
        ...headers,
      },
    });
  }

  get(url: string) {
    return this.request('GET', url);
  }
  post(url: string, payload: unknown = {}) {
    return this.request('POST', url, payload);
  }
  patch(url: string, payload: unknown) {
    return this.request('PATCH', url, payload);
  }
  put(url: string, payload: unknown) {
    return this.request('PUT', url, payload);
  }
  delete(url: string) {
    return this.request('DELETE', url);
  }
}

export async function loginAs(app: FastifyInstance, user: { email: string }): Promise<Client> {
  const c = new Client(app);
  const r = await c.login(user.email);
  if (r.statusCode !== 200) throw new Error(`login falhou: ${r.statusCode} ${r.body}`);
  return c;
}

/** Cria uma lista com N leads direto no banco (telefones fictícios válidos para os testes). */
export async function seedList(
  db: Db,
  opts: { name?: string; count: number; createdBy?: string; assignTo?: string | null; phoneStart?: number },
): Promise<{ listId: string; leadIds: number[] }> {
  const list = await db
    .insertInto('lists')
    .values({
      name: opts.name ?? 'Lista de teste',
      created_by: opts.createdBy ?? null,
      distribution: 'fila',
      total: opts.count,
      extra_columns: ['Cidade'],
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const start = opts.phoneStart ?? 0;
  const rows = Array.from({ length: opts.count }, (_, i) => {
    const name = `Cliente ${start + i + 1}`;
    return {
      list_id: list.id,
      row_number: i + 2,
      name,
      name_search: normalizeText(name),
      phone: testPhone(start + i),
      phone_type: 'movel' as const,
      extra: JSON.stringify({ Cidade: 'Curitiba' }),
      assigned_to: opts.assignTo ?? null,
      assigned_at: opts.assignTo ? new Date() : null,
      assigned_via: opts.assignTo ? ('importacao' as const) : null,
    };
  });
  const ids: number[] = [];
  for (let i = 0; i < rows.length; i += 1000) {
    const r = await db
      .insertInto('leads')
      .values(rows.slice(i, i + 1000))
      .returning('id')
      .execute();
    ids.push(...r.map((x) => x.id));
  }
  return { listId: list.id, leadIds: ids };
}

/** Celular de teste no formato E.164 (nunca é discado: os testes não abrem o WhatsApp). */
export function testPhone(n: number): string {
  return `55419${String(80_000_000 + n).padStart(8, '0')}`;
}

export async function countRows(
  db: Db,
  table: 'leads' | 'lists' | 'lead_events' | 'imports',
): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(db);
  return r.rows[0]?.n ?? 0;
}
