import { defineConfig, devices } from '@playwright/test';

/**
 * Offline suite (PRD §19: "The PWA works completely offline after the first enrolment"). Runs a
 * production build with its service worker on the Workers assets server, on the PWA's own port
 * (the API only accepts that origin), against a fresh local API + D1.
 */
export default defineConfig({
  testDir: 'e2e-offline',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    ...devices['Pixel 7'],
    serviceWorkers: 'allow',
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
      // Served by the real Workers static-assets server (as on Cloudflare), not `vite preview`: it
      // redirects /index.html to /, which the service worker must handle.
      command: 'pnpm exec vite build --mode test && pnpm exec wrangler dev --port 5173 --inspector-port 9231',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
