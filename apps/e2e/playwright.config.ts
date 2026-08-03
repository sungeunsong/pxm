import { defineConfig, devices } from '@playwright/test';

const webPort = Number(process.env.PXM_E2E_WEB_PORT || 5274);

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test-results/report', open: 'never' }],
  ],
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        headless: process.env.PXM_E2E_HEADED !== 'true',
      },
    },
  ],
});
