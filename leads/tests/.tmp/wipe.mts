// Zera o banco LOCAL (127.0.0.1) para começar sem os dados de demonstração.
import { sql } from 'kysely';
import { createDb, createPool } from '../../src/server/db';
import { migrateToLatest } from '../../src/server/db/migrate';
import { scriptDatabase } from '../../src/server/scripts/script-db';
const t = await scriptDatabase();
if (new URL(t.url).hostname !== '127.0.0.1') throw new Error('não é o banco local');
const db = createDb(createPool(t.url, 1));
await sql`DROP SCHEMA public CASCADE; CREATE SCHEMA public`.execute(db);
console.log('migrações:', (await migrateToLatest(db)).join(', '));
const n = await sql<{ users: number; leads: number; tpl: string }>`SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM leads)::int AS leads, (SELECT string_agg(name, ', ') FROM message_templates) AS tpl`.execute(db);
console.log(n.rows[0]);
await db.destroy();
await t.done();
