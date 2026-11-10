/**
 * Doctor-only: users and devices (PRD §9: "Users, devices, revoke").
 * Mounted at `/admin`; every route here is behind one doctor-only guard.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { devices, users } from '@yegna/db';
import {
  type DeviceInfo,
  createUserRequest,
  doctorPinSchema,
  normalizeName,
  updateUserRequest,
} from '@yegna/shared';
import { auditInsert } from '../lib/audit.ts';
import { hashPin } from '../lib/crypto.ts';
import { CURRENT_VERSION, type Db, bumpVersion, isUniqueViolation } from '../lib/db.ts';
import { type AppEnv, fail, parseBody } from '../lib/http.ts';
import { clearAttempts } from '../lib/rateLimit.ts';
import { requireDevice, requireDoctor } from '../lib/session.ts';
import { enrolKeyForName } from './auth.ts';

export const admin = new Hono<AppEnv>();
admin.use('*', requireDevice, requireDoctor);

/** Enrolment is by name + PIN, so active names must be unique. */
async function nameTaken(db: Db, name: string, exceptId?: string): Promise<boolean> {
  const active = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(isNull(users.disabledAt), isNull(users.deletedAt)))
    .all();
  return active.some((u) => u.id !== exceptId && normalizeName(u.name) === normalizeName(name));
}

admin.get('/users', async (c) => {
  const rows = await c
    .get('db')
    .select({ id: users.id, name: users.name, role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .where(isNull(users.deletedAt))
    .all();
  return c.json(rows);
});

admin.post('/users', async (c) => {
  const body = await parseBody(c, createUserRequest);
  if (!body) return fail(c, 400, 'bad_request');
  const db = c.get('db');
  const session = c.get('session');
  if (await nameTaken(db, body.name)) return fail(c, 409, 'name_taken');
  const now = Date.now();
  const { hash, salt } = await hashPin(body.pin);
  try {
    await db.batch([
      bumpVersion(db),
      db.insert(users).values({
        id: body.id,
        name: body.name,
        role: 'staff',
        pinHash: hash,
        pinSalt: salt,
        version: CURRENT_VERSION,
        updatedAt: now,
        updatedBy: session.user.id,
      }),
      auditInsert(db, session, 'users', body.id, 'create', { role: 'staff' }, now),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) return fail(c, 409, 'conflict');
    throw err;
  }
  return c.json({ id: body.id, name: body.name, role: 'staff', disabledAt: null }, 201);
});

admin.patch('/users/:id', async (c) => {
  const body = await parseBody(c, updateUserRequest);
  if (!body) return fail(c, 400, 'bad_request');
  const db = c.get('db');
  const session = c.get('session');
  const id = c.req.param('id');
  const target = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .get();
  if (!target) return fail(c, 404, 'not_found');
  if (id === session.user.id && body.disabled !== undefined) return fail(c, 400, 'cannot_change_self');
  if (body.pin && target.role === 'doctor' && !doctorPinSchema.safeParse(body.pin).success) {
    return fail(c, 400, 'bad_request');
  }
  // The resulting user must have a unique name if it will be active (renamed or re-enabled).
  const willBeActive = body.disabled === false || (body.disabled === undefined && !target.disabledAt);
  if (
    (body.name || body.disabled === false) &&
    willBeActive &&
    (await nameTaken(db, body.name ?? target.name, id))
  ) {
    return fail(c, 409, 'name_taken');
  }

  const now = Date.now();
  const pin = body.pin ? await hashPin(body.pin) : null;
  const disabledAt = body.disabled === undefined ? target.disabledAt : body.disabled ? now : null;
  await db.batch([
    bumpVersion(db),
    db
      .update(users)
      .set({
        name: body.name ?? target.name,
        ...(pin ? { pinHash: pin.hash, pinSalt: pin.salt } : {}),
        disabledAt,
        // A disabled user's Telegram is unlinked: no team messages reach them any more.
        ...(body.disabled ? { telegramChatId: null } : {}),
        version: CURRENT_VERSION,
        updatedAt: now,
        updatedBy: session.user.id,
      })
      .where(eq(users.id, id)),
    // Disabling a user signs out all their devices.
    db
      .update(devices)
      .set({ revokedAt: now })
      .where(and(eq(devices.userId, id), body.disabled ? isNull(devices.revokedAt) : eq(devices.id, ''))),
    auditInsert(
      db,
      session,
      'users',
      id,
      'update',
      {
        ...(body.name ? { name: [target.name, body.name] } : {}),
        ...(pin ? { pin: 'changed' } : {}),
        ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
      },
      now,
    ),
  ]);
  // A PIN reset or re-enable by the Doctor lifts any lockout on that name (old and new, if renamed).
  if (pin || body.disabled === false) {
    const names = [...new Set([target.name, body.name ?? target.name])];
    await clearAttempts(db, await Promise.all(names.map(enrolKeyForName)));
  }
  return c.json({ id, name: body.name ?? target.name, role: target.role, disabledAt });
});

admin.get('/devices', async (c) => {
  const rows = await c
    .get('db')
    .select({
      id: devices.id,
      userId: devices.userId,
      userName: users.name,
      label: devices.label,
      createdAt: devices.createdAt,
      lastSeenAt: devices.lastSeenAt,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .orderBy(desc(devices.createdAt))
    .all();
  return c.json(rows satisfies DeviceInfo[]);
});

admin.post('/devices/:id/revoke', async (c) => {
  const db = c.get('db');
  const session = c.get('session');
  const id = c.req.param('id');
  if (id === session.deviceId) return fail(c, 400, 'cannot_change_self');
  const device = await db.select().from(devices).where(eq(devices.id, id)).get();
  if (!device) return fail(c, 404, 'not_found');
  if (device.revokedAt) return c.json({ id, revokedAt: device.revokedAt });
  const now = Date.now();
  await db.batch([
    db.update(devices).set({ revokedAt: now }).where(eq(devices.id, id)),
    auditInsert(db, session, 'devices', id, 'revoke', null, now),
  ]);
  return c.json({ id, revokedAt: now });
});
