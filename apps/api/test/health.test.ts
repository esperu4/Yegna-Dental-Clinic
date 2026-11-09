import { describe, expect, it } from 'vitest';
import app from '../src/index.ts';

describe('GET /health', () => {
  it('reports ok and the environment', async () => {
    const env = {
      ENVIRONMENT: 'local',
      DB: { prepare: () => ({ first: async () => ({ ok: 1 }) }) },
    } as unknown as Env;
    const res = await app.request('/health', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, env: 'local' });
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await app.request('/nope', {}, {} as Env);
    expect(res.status).toBe(404);
  });
});
