import { defineConfig, devices } from '@playwright/test';

/** PWA end-to-end tests against a real local API + D1 (fresh state each run). */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    ...devices['Pixel 7'],
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node e2e/start-api.mjs',
      url: 'http://localhost:8787/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm exec vite --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
