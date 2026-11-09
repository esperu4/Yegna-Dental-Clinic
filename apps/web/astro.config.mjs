import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  // Staging runs on workers.dev; the real domain is set once DNS is decided (PRD §22 #7).
  site: process.env.SITE_URL ?? 'https://yegna-web-staging.yegna-api.workers.dev',
});
