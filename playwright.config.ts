import { defineConfig, devices } from '@playwright/test';

export const E2E_PORT = 4310;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/e2e',
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'computador', use: { ...devices['Desktop Chrome'] }, testIgnore: /celular/ },
    { name: 'celular', use: { ...devices['Pixel 7'] }, testMatch: /celular/, dependencies: ['computador'] },
  ],
  webServer: {
    // Compila e sobe o servidor de produção (dist/) com um banco novo. Veja tests/e2e/server.ts.
    command: 'node node_modules/tsx/dist/cli.mjs tests/e2e/server.ts',
    url: `http://127.0.0.1:${E2E_PORT}/api/health`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
