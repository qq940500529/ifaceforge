import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 75000,
  expect: { timeout: 15000 },
  workers: 2,
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 12000,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
