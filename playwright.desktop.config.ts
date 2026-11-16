import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/desktop',
  timeout: 90000,
  expect: { timeout: 12000 },
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-desktop-report' }]],
  use: { screenshot: 'only-on-failure', actionTimeout: 10000 },
});
