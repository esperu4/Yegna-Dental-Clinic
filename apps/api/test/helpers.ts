import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { type EnrolResponse, uuidv7 } from '@yegna/shared';
import { app } from '../src/index.ts';
import { meterD1 } from '../src/lib/queryMeter.ts';

const MIGRATIONS = join(import.meta.dirname, '..', '..', '..', 'packages', 'db', 'migrations');
export const SETUP_CODE = 'test-setup-code-0123456789abcdef0123';
export const PWA_ORIGIN = 'http://localhost:5173';

/** A fresh in-memory local D1 with all migrations applied, as the Worker sees it. */
export async function createTestEnv(overrides: Partial<Env> = {}) {
  const proxy = await getPlatformProxy<Env>({
    configPath: join(import.meta.dirname, '..', 'wrangler.jsonc'),
    persist: false,
  });
  const statements = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), 'utf8').split('--> statement-breakpoint'))
    .map((s) => s.trim())
    .filter(Boolean);
  await proxy.env.DB.batch(statements.map((s) => proxy.env.DB.prepare(s)));
  const env: Env = { ...proxy.env, SETUP_CODE, ...overrides };
  return { env, dispose: () => proxy.dispose() };
}

export type Call = (
  method: string,
  path: string,
  opts?: { body?: unknown; token?: string; headers?: Record<string, string> },
) => Promise<{ status: number; json: Record<string, unknown> & { error?: string }; headers: Headers }>;

export function caller(env: Env): Call {
  return async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    const res = await app.request(
      path,
      { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) },
      env,
    );
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {}, headers: res.headers };
  };
}

export async function setupDoctor(call: Call, name = 'Dr. Selam', pin = '258014') {
  const res = await call('POST', '/setup', {
    body: { code: SETUP_CODE, userId: uuidv7(), name, pin, deviceLabel: 'Doctor phone' },
  });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json as unknown as EnrolResponse;
}

export async function addStaff(call: Call, doctorToken: string, name: string, pin: string) {
  const id = uuidv7();
  const res = await call('POST', '/admin/users', { token: doctorToken, body: { id, name, pin } });
  if (res.status !== 201) throw new Error(`add staff failed: ${res.status}`);
  return id;
}

/** Empty every app table between tests (children before parents, for foreign keys). */
export async function resetDb(env: Env) {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
  ).all<{ name: string }>();
  const order = [
    'audit_log',
    'import_rows',
    'patient_requests',
    'bookings',
    'imports',
    'devices',
    'telegram_link_codes',
  ];
  const names = tables.results
    .map((t) => t.name)
    .sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    });
  await env.DB.batch(names.map((n) => env.DB.prepare(`DELETE FROM ${n}`)));
}

/** Counts D1 queries made through `env.DB` (same counter as production, see queryMeter.ts). */
export function countingD1(d1: D1Database) {
  let meter = meterD1(d1);
  const db = new Proxy(d1, { get: (_t, prop) => Reflect.get(meter.d1, prop) as unknown });
  return { db, queries: () => meter.used(), reset: () => (meter = meterD1(d1)) };
}
