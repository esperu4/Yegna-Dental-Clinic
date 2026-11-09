import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  test: { environment: 'node', include: ['test/**/*.test.{ts,tsx}'] },
} as Parameters<typeof defineConfig>[0]);
