import { Hono } from 'hono';

const app = new Hono<{ Bindings: Env }>();

/** Liveness + D1 reachability. Returns no data beyond the environment name. */
app.get('/health', async (c) => {
  const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return c.json({ ok: row?.ok === 1, env: c.env.ENVIRONMENT });
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;
