import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Call, caller, createTestEnv } from './helpers.ts';

let call: Call;
let dispose: () => Promise<void>;
beforeAll(async () => {
  const t = await createTestEnv();
  call = caller(t.env);
  dispose = t.dispose;
});
afterAll(() => dispose());

describe('GET /health', () => {
  it('reports ok and the environment', async () => {
    const res = await call('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, env: 'local' });
  });

  it('returns JSON 404 for unknown routes, even without a token', async () => {
    const res = await call('GET', '/nope');
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'not_found' });
  });
});
