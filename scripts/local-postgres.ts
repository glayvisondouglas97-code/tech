/**
 * Postgres local sem Docker, para desenvolvimento e testes.
 *
 * Usa os binários do pacote `embedded-postgres`, mas sobe o servidor com `pg_ctl`.
 * No Windows, o `pg_ctl` descarta os privilégios de administrador antes de iniciar
 * o Postgres, então funciona mesmo num terminal "como administrador".
 * Em produção, use um Postgres de verdade (ver README).
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * `pg_ctl start` deixa o processo do Postgres herdando a saída padrão.
 * Com `execFile` o Node espera essa saída fechar e trava; por isso ignoramos o stdio.
 */
function runIgnoringOutput(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} terminou com código ${code}`)),
    );
  });
}

export interface LocalPostgres {
  url: string;
  stop: () => Promise<void>;
}

interface Binaries {
  pg_ctl: string;
  initdb: string;
}

async function binaries(): Promise<Binaries> {
  const plat = platform() === 'win32' ? 'windows' : platform();
  const pkg = `@embedded-postgres/${plat}-${arch()}`;
  try {
    return (await import(pkg)) as Binaries;
  } catch {
    throw new Error(
      `Não encontrei os binários do Postgres para ${plat}-${arch()} (${pkg}). ` +
        'Rode "npm install" de novo ou defina DATABASE_URL apontando para um Postgres.',
    );
  }
}

async function isRunning(bin: Binaries, dataDir: string): Promise<boolean> {
  try {
    await run(bin.pg_ctl, ['-D', dataDir, 'status']);
    return true;
  } catch {
    return false;
  }
}

export async function startLocalPostgres(opts: {
  dataDir: string;
  port: number;
  password?: string;
  quiet?: boolean;
  /** Desliga o fsync: mais rápido, mas só serve para bancos descartáveis (testes). */
  disposable?: boolean;
}): Promise<LocalPostgres> {
  const bin = await binaries();
  const password = opts.password ?? 'postgres';
  const log = (msg: string) => {
    if (!opts.quiet) console.log(`[postgres] ${msg}`);
  };

  if (!existsSync(join(opts.dataDir, 'PG_VERSION'))) {
    mkdirSync(opts.dataDir, { recursive: true });
    const pwfile = join(opts.dataDir, '..', `.pw-${process.pid}`);
    writeFileSync(pwfile, password);
    log(`criando banco local em ${opts.dataDir}`);
    await run(bin.initdb, [
      '-D',
      opts.dataDir,
      '-U',
      'postgres',
      `--pwfile=${pwfile}`,
      '--auth=scram-sha-256',
      '-E',
      'UTF8',
      '--locale=C',
    ]);
    rmSync(pwfile, { force: true });
  }

  if (await isRunning(bin, opts.dataDir)) {
    log('já estava rodando');
  } else {
    await runIgnoringOutput(bin.pg_ctl, [
      '-D',
      opts.dataDir,
      '-o',
      `-p ${opts.port} -c listen_addresses=127.0.0.1 -c max_connections=200${opts.disposable ? ' -c fsync=off -c synchronous_commit=off' : ''}`,
      '-l',
      join(opts.dataDir, 'server.log'),
      '-w',
      'start',
    ]);
    log(`rodando na porta ${opts.port}`);
  }

  return {
    url: `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${opts.port}/postgres`,
    stop: async () => {
      if (await isRunning(bin, opts.dataDir)) {
        await run(bin.pg_ctl, ['-D', opts.dataDir, '-m', 'fast', '-w', 'stop']);
        log('parado');
      }
    },
  };
}

export const LOCAL_DATA_DIR = '.data/pg';
export const LOCAL_PORT = 54320;

/**
 * Banco local de desenvolvimento (.data/pg, porta 54320, banco "chamador").
 * Se já estiver rodando (por exemplo, pelo "npm run dev"), só reaproveita.
 * `stop` só desliga se foi esta chamada que ligou.
 */
export async function ensureLocalDatabase(
  opts: { quiet?: boolean } = {},
): Promise<{ url: string; stop: () => Promise<void> }> {
  const { resolve } = await import('node:path');
  const dataDir = resolve(LOCAL_DATA_DIR);
  const bin = await binaries();
  const wasRunning = existsSync(join(dataDir, 'PG_VERSION')) && (await isRunning(bin, dataDir));
  const pg = await startLocalPostgres({ dataDir, port: LOCAL_PORT, quiet: opts.quiet });
  const { default: pgLib } = await import('pg');
  const client = new pgLib.Client({ connectionString: pg.url });
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = 'chamador'");
  if (!exists.rowCount) await client.query('CREATE DATABASE chamador');
  await client.end();
  return {
    url: pg.url.replace(/\/postgres$/, '/chamador'),
    stop: wasRunning ? async () => {} : pg.stop,
  };
}
