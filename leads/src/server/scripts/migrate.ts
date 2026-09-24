import { createDb, createPool } from '../db';
import { migrateToLatest } from '../db/migrate';
import { scriptDatabase } from './script-db';

const target = await scriptDatabase();
const db = createDb(createPool(target.url, 2));
try {
  const applied = await migrateToLatest(db);
  console.log(
    applied.length ? `Migrações aplicadas: ${applied.join(', ')}` : 'O banco já estava atualizado.',
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.destroy();
  await target.done();
}
