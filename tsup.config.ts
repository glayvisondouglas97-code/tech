import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/server/index.ts',
    'parse-worker': 'src/server/modules/imports/parse-worker.ts',
    migrate: 'src/server/scripts/migrate.ts',
    'criar-admin': 'src/server/scripts/create-admin.ts',
    seed: 'src/server/scripts/seed.ts',
  },
  outDir: 'dist/server',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  splitting: true,
  sourcemap: true,
  clean: true,
  // Pacotes que só existem no desenvolvimento (Postgres local).
  external: ['embedded-postgres', /^@embedded-postgres\//],
});
