import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  // System Chrome (Playwright's bundled browsers are not installed in this environment).
  use: { baseURL: 'http://localhost:3100', channel: 'chrome', trace: 'retain-on-failure', viewport: { width: 1440, height: 900 } },
});
