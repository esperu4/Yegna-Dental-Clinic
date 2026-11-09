/** Device-token authentication (PRD §18): every request carries `Authorization: Bearer <token>`. */
import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { devices, users } from '@yegna/db';
import { sha256Hex } from './crypto.ts';
import { type AppEnv, fail } from './http.ts';

const TOKEN = /^Bearer ([0-9a-f]{64})$/;
/** Only refresh `last_seen_at` this often, to stay inside the D1 write budget (PRD §19). */
const SEEN_GRANULARITY_MS = 5 * 60_000;

export const requireDevice = createMiddleware<AppEnv>(async (c, next) => {
  const match = TOKEN.exec(c.req.header('Authorization') ?? '');
  if (!match) return fail(c, 401, 'unauthorized');
  const db = c.get('db');
  const row = await db
    .select({ device: devices, user: users })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(eq(devices.tokenHash, await sha256Hex(match[1]!)))
    .get();
  if (!row) return fail(c, 401, 'unauthorized');
  // `revoked` tells the device to wipe itself and return to enrolment (PRD §7.9).
  if (row.device.revokedAt || row.user.disabledAt || row.user.deletedAt) return fail(c, 401, 'revoked');

  const now = Date.now();
  if (!row.device.lastSeenAt || now - row.device.lastSeenAt > SEEN_GRANULARITY_MS) {
    await db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, row.device.id));
  }
  c.set('session', {
    deviceId: row.device.id,
    user: {
      id: row.user.id,
      name: row.user.name,
      role: row.user.role,
      locale: row.user.locale,
      calendar: row.user.calendar,
    },
  });
  await next();
});

export const requireDoctor = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('session').user.role !== 'doctor') return fail(c, 403, 'forbidden');
  await next();
});
