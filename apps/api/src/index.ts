import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getDb } from './lib/db.ts';
import { meterD1 } from './lib/queryMeter.ts';
import type { AppEnv } from './lib/http.ts';
import { admin } from './routes/admin.ts';
import { auth } from './routes/auth.ts';
import { sync } from './routes/sync.ts';
import { telegram } from './routes/telegram.ts';
import { runHourly } from './jobs/dispatch.ts';

const app = new Hono<AppEnv>();

// Refuse to serve a deployed environment that still trusts a localhost origin.
app.use('*', async (c, next) => {
  if (c.env.ENVIRONMENT !== 'local' && c.env.PWA_ORIGIN.startsWith('http://localhost')) {
    console.error('misconfigured', 'PWA_ORIGIN is localhost outside local');
    return c.json({ error: 'server_error' }, 500);
  }
  await next();
});

// The API accepts only the PWA origin (PRD §18).
app.use('*', (c, next) =>
  cors({
    origin: (origin) => (origin === c.env.PWA_ORIGIN ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86_400,
  })(c, next),
);

app.use('*', async (c, next) => {
  // Every query is counted against the per-invocation D1 limit (see lib/queryMeter.ts).
  const meter = meterD1(c.env.DB);
  c.set('meter', meter);
  c.set('db', getDb(meter.d1));
  await next();
});

/** Liveness + D1 reachability. Returns no data beyond the environment name. */
app.get('/health', async (c) => {
  const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return c.json({ ok: row?.ok === 1, env: c.env.ENVIRONMENT });
});

app.route('/', auth);
app.route('/admin', admin);
app.route('/sync', sync);
app.route('/', telegram);

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((err, c) => {
  // Log the error type only: request bodies may contain names or phones (PRD §18).
  console.error('unhandled', err.name, c.req.method, c.req.routePath);
  return c.json({ error: 'server_error' }, 500);
});

export default {
  fetch: app.fetch,
  /** The hourly cron (wrangler.jsonc `triggers`); see jobs/dispatch.ts. */
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runHourly(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;

/** The Hono app, for tests (`app.request`). */
export { app };
