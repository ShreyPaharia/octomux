import path from 'path';
import { defineConfig } from '@playwright/test';

const docsDbPath = process.env.OCTOMUX_DB_PATH
  ? path.resolve(process.env.OCTOMUX_DB_PATH)
  : undefined;
/** README capture — always boot an isolated server (never reuse a dev `octomux start`). */
const docsScreenshots = !!process.env.OCTOMUX_SCREENSHOTS;
const reuseServer = !process.env.CI && !docsScreenshots;
const backendPort = docsScreenshots
  ? '7788'
  : process.env.OCTOMUX_PORT || process.env.PORT || '7777';
const vitePort = docsScreenshots ? '5174' : '5173';
const backendEnv = {
  NODE_ENV: 'test',
  PORT: backendPort,
  OCTOMUX_PORT: backendPort,
  ...(docsDbPath ? { OCTOMUX_DB_PATH: docsDbPath } : {}),
};

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // tasks share a DB, run serially
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    baseURL: `http://localhost:${vitePort}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  webServer: [
    {
      command: 'npx tsx server/index.ts',
      url: `http://localhost:${backendPort}/api/tasks`,
      reuseExistingServer: reuseServer,
      timeout: 15_000,
      env: backendEnv,
    },
    {
      command: `npx vite --port ${vitePort}`,
      url: `http://localhost:${vitePort}`,
      reuseExistingServer: reuseServer,
      timeout: 15_000,
      env: { PORT: backendPort },
    },
  ],

  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
