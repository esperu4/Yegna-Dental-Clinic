/**
 * First-doctor setup, device enrolment and the current user (PRD §8 item 1).
 * Setup needs the one-time SETUP_CODE secret (docs/adr/0005-first-doctor-setup-code.md).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { devices, users } from '@yegna/db';
import {
  type EnrolResponse,
  type SessionUser,
  enrolRequest,
  normalizeName,
  setupRequest,
  updateMeRequest,
  uuidv7,
} from '@yegna/shared';
import { auditInsert, auditLockout } from '../lib/audit.ts';
import {
  PIN_HASH_ITERATIONS,
  hashPin,
  newDeviceToken,
  safeEqual,
  sha256Hex,
  verifyPin,
} from '../lib/crypto.ts';
import { CURRENT_VERSION, type Db, bumpVersion, withVersion } from '../lib/db.ts';
import { type AppEnv, fail, parseBody } from '../lib/http.ts';
import { LIMITS, attemptSucceeded, ipKeyFor, takeAttempt } from '../lib/rateLimit.ts';
import { requireDevice } from '../lib/session.ts';

const SETUP_KEY = 'setup';
/** A setup code shorter than this is treated as not configured (e.g. `openssl rand -hex 16` gives 32). */
export const MIN_SETUP_CODE_LENGTH = 32;
/** Used to spend the same hashing time when no user matches, so timing doesn't reveal names. */
const DUMMY_SALT = '00000000000000000000000000000000';
const DUMMY_HASH = `pbkdf2-sha256$${PIN_HASH_ITERATIONS}$${'0'.repeat(64)}`;

export const auth = new Hono<AppEnv>();

/** Setup is possible only while the users table is completely empty (not merely "no live doctor"). */
async function anyUserExists(db: Db): Promise<boolean> {
  return Boolean(await db.select({ id: users.id }).from(users).limit(1).get());
}

async function ipKey(c: Context<AppEnv>): Promise<string> {
  return ipKeyFor(c.req.header('CF-Connecting-IP'));
}

function nameKey(hash: string): string {
  return `enrol:${hash}`;
}

export async function enrolKeyForName(name: string): Promise<string> {
  return nameKey(await sha256Hex(normalizeName(name)));
}

auth.get('/setup', async (c) => c.json({ needed: !(await anyUserExists(c.get('db'))) }));

auth.post('/setup', async (c) => {
  const code = c.env.SETUP_CODE;
  if (!code || code.length < MIN_SETUP_CODE_LENGTH) return fail(c, 503, 'setup_disabled');
  const body = await parseBody(c, setupRequest);
  if (!body) return fail(c, 400, 'bad_request');
  const db = c.get('db');
  const now = Date.now();
  if (await anyUserExists(db)) return fail(c, 409, 'already_set_up');

  const ip = await ipKey(c);
  const attempt = await takeAttempt(
    db,
    [
      { key: SETUP_KEY, max: LIMITS.setup },
      { key: ip, max: LIMITS.ip },
    ],
    now,
  );
  if (!attempt.ok) return fail(c, 429, 'locked', { retryAfterMs: attempt.retryAfterMs });
  if (attempt.lockedNow.length) await auditLockout(db, attempt.lockedNow, now);
  if (!safeEqual(body.code, code)) return fail(c, 401, 'invalid_credentials');

  const { hash, salt } = await hashPin(body.pin);
  // Conditional insert: if two setups race, only one user (the doctor) is created.
  const [inserted] = await withVersion(
    db,
    sql`INSERT INTO users (id, name, role, pin_hash, pin_salt, locale, calendar, version, updated_at, updated_by)
        SELECT ${body.userId}, ${body.name}, 'doctor', ${hash}, ${salt}, ${body.locale}, ${body.calendar},
               ${CURRENT_VERSION}, ${now}, ${body.userId}
        WHERE NOT EXISTS (SELECT 1 FROM users)`,
  );
  if (!inserted?.meta.changes) return fail(c, 409, 'already_set_up');

  const user: SessionUser = {
    id: body.userId,
    name: body.name,
    role: 'doctor',
    locale: body.locale,
    calendar: body.calendar,
  };
  const deviceId = uuidv7(now);
  const { token, tokenHash } = await newDeviceToken();
  await db.batch([
    db
      .insert(devices)
      .values({ id: deviceId, userId: user.id, tokenHash, label: body.deviceLabel, createdAt: now }),
    auditInsert(db, { deviceId, user }, 'users', user.id, 'setup', { role: 'doctor' }, now),
  ]);
  await attemptSucceeded(db, [SETUP_KEY], [ip], attempt.ticket);
  return c.json({ token, deviceId, user } satisfies EnrolResponse, 201);
});

auth.post('/enrol', async (c) => {
  const body = await parseBody(c, enrolRequest);
  if (!body) return fail(c, 400, 'bad_request');
  const db = c.get('db');
  const now = Date.now();
  const key = await enrolKeyForName(body.name);
  const ip = await ipKey(c);

  // Counted before the PIN is checked, so parallel guesses can't exceed the limits.
  const attempt = await takeAttempt(
    db,
    [
      { key, max: LIMITS.name },
      { key: ip, max: LIMITS.ip },
    ],
    now,
  );
  if (!attempt.ok) return fail(c, 429, 'locked', { retryAfterMs: attempt.retryAfterMs });
  if (attempt.lockedNow.length) await auditLockout(db, attempt.lockedNow, now);

  const active = await db
    .select()
    .from(users)
    .where(and(isNull(users.disabledAt), isNull(users.deletedAt)))
    .all();
  const candidates = active.filter(
    (u) => normalizeName(u.name) === normalizeName(body.name) && u.pinHash && u.pinSalt,
  );
  let match: (typeof active)[number] | undefined;
  for (const u of candidates) {
    if (await verifyPin(body.pin, u.pinHash!, u.pinSalt!)) {
      match = u;
      break;
    }
  }
  if (candidates.length === 0) await verifyPin(body.pin, DUMMY_HASH, DUMMY_SALT);
  if (!match) return fail(c, 401, 'invalid_credentials');

  const deviceId = uuidv7(now);
  const { token, tokenHash } = await newDeviceToken();
  const user: SessionUser = {
    id: match.id,
    name: match.name,
    role: match.role,
    locale: match.locale,
    calendar: match.calendar,
  };
  await db.batch([
    db
      .insert(devices)
      .values({ id: deviceId, userId: user.id, tokenHash, label: body.deviceLabel, createdAt: now }),
    auditInsert(db, { deviceId, user }, 'devices', deviceId, 'enrol', null, now),
  ]);
  await attemptSucceeded(db, [key], [ip], attempt.ticket);
  return c.json({ token, deviceId, user } satisfies EnrolResponse, 201);
});

auth.get('/me', requireDevice, (c) => c.json(c.get('session')));

auth.patch('/me', requireDevice, async (c) => {
  const body = await parseBody(c, updateMeRequest);
  if (!body) return fail(c, 400, 'bad_request');
  const db = c.get('db');
  const session = c.get('session');
  const now = Date.now();
  await db.batch([
    bumpVersion(db),
    db
      .update(users)
      .set({ ...body, version: CURRENT_VERSION, updatedAt: now, updatedBy: session.user.id })
      .where(eq(users.id, session.user.id)),
  ]);
  return c.json({ ...session, user: { ...session.user, ...body } });
});
