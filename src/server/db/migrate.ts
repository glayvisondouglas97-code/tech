import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';
import type { Db } from './index';
import * as m0001 from './migrations/0001_inicial';
import * as m0002 from './migrations/0002_empresas_dono_limites';
import * as m0003 from './migrations/0003_whatsapp';
import * as m0004 from './migrations/0004_chamar_pelo_sistema';
import * as m0005 from './migrations/0005_numeros_por_responsavel';
import * as m0006 from './migrations/0006_exclusoes';
import * as m0007 from './migrations/0007_audios';

/** Lista fixa de migrações: funciona igual no código TypeScript e no build empacotado. */
const migrations: Record<string, Migration> = {
  '0001_inicial': m0001,
  '0002_empresas_dono_limites': m0002,
  '0003_whatsapp': m0003,
  '0004_chamar_pelo_sistema': m0004,
  '0005_numeros_por_responsavel': m0005,
  '0006_exclusoes': m0006,
  '0007_audios': m0007,
};

class StaticProvider implements MigrationProvider {
  async getMigrations() {
    return migrations;
  }
}

export async function migrateToLatest(db: Db): Promise<string[]> {
  const migrator = new Migrator({
    db,
    provider: new StaticProvider(),
    migrationTableName: 'schema_migrations',
    migrationLockTableName: 'schema_migrations_lock',
  });
  const { error, results } = await migrator.migrateToLatest();
  const applied = (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
  if (error) {
    const failed = (results ?? []).find((r) => r.status === 'Error');
    throw new Error(
      `Falha ao atualizar o banco${failed ? ` na migração ${failed.migrationName}` : ''}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return applied;
}
