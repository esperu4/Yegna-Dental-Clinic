import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { serviceWorker } from './build/serviceWorker.ts';

/** API base URL per build mode. Local dev talks to `wrangler dev` on port 8787. */
const API_URLS: Record<string, string> = {
  development: 'http://localhost:8787',
  test: 'http://localhost:8787',
  staging: 'https://yegna-api-staging.yegna-api.workers.dev',
};

export default defineConfig(({ mode }) => {
  const define = { __API_URL__: JSON.stringify(API_URLS[mode] ?? API_URLS.development) };
  return {
    plugins: [preact(), serviceWorker({ entry: 'src/sw.ts', define })],
    define,
    test: { environment: 'node', include: ['test/**/*.test.{ts,tsx}'] },
  };
});
