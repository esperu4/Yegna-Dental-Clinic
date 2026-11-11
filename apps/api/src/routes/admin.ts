/**
 * Doctor-only: users and devices (PRD §9: "Users, devices, revoke").
 * Mounted at `/admin`; every route here is behind one doctor-only guard.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { devices, telegramLinkCodes, users } from '@yegna/db';
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
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      disabledAt: users.disabledAt,
      // Whether Telegram is linked, never the chat id itself.
      telegramLinked: sql<number>`${users.telegramChatId} IS NOT NULL`,
    })
    .from(users)
    .where(isNull(users.deletedAt))
    .all();
  return c.json(rows.map((r) => ({ ...r, telegramLinked: Boolean(r.telegramLinked) })));
});

/**
 * Unlinks a team member's Telegram (e.g. they changed phone number or left the clinic chat), and
 * voids their unused link codes. The member can link again from their own Settings.
 */
admin.post('/users/:id/telegram/unlink', async (c) => {
  const db = c.get('db');
  const session = c.get('session');
  const id = c.req.param('id');
  const target = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .get();
  if (!target) return fail(c, 404, 'not_found');
  const now = Date.now();
  await db.batch([
    db.update(users).set({ telegramChatId: null }).where(eq(users.id, id)),
    db.delete(telegramLinkCodes).where(eq(telegramLinkCodes.userId, id)),
    auditInsert(db, session, 'users', id, 'telegram_unlink', null, now),
  ]);
  return c.json({ id, telegramLinked: false });
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
    // Disabling a user drops their unused Telegram link codes.
    db
      .delete(telegramLinkCodes)
      .where(and(eq(telegramLinkCodes.userId, id), body.disabled ? sql`1` : sql`0`)),
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
    // A lost or stolen phone: its user's Telegram is unlinked too, so team messages (with patient
    // names) stop reaching that phone. They link again from a phone they still have.
    db.update(users).set({ telegramChatId: null }).where(eq(users.id, device.userId)),
    db.delete(telegramLinkCodes).where(eq(telegramLinkCodes.userId, device.userId)),
    auditInsert(db, session, 'devices', id, 'revoke', null, now),
  ]);
  return c.json({ id, revokedAt: now });
});
