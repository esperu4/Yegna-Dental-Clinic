/**
 * Server-side PIN lockout (PRD §8 item 1, §18).
 *
 * Every attempt is counted atomically *before* the PIN or code is checked, so parallel requests
 * cannot get more guesses than the limit; a refused attempt counts nothing. Reaching the limit locks the key;
 * each further lockout (without a success in between) doubles: 5, 10, 20, 40, then 80 minutes.
 * A request learns whether it was let through by finding its own random ticket in the row.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { authAttempts } from '@yegna/db';
import { randomHex, sha256Hex } from './crypto.ts';
import type { Db } from './db.ts';

export const LOCKOUT_BASE_MS = 5 * 60_000;
/** The lockout doubles at most this many times (5 min × 2⁴ = 80 min). */
const MAX_DOUBLINGS = 4;

export const LIMITS = {
  /** Per user name (PRD: five wrong PINs ⇒ lockout). */
  name: 5,
  /**
   * Per client network (IPv4 /24, IPv6 /64), across names: stops one PIN being tried against many
   * names. There is deliberately no clinic-wide lock: anyone could hold it shut for everyone.
   */
  ip: 10,
  /** The one-time setup code. */
  setup: 5,
} as const;

export interface AttemptKey {
  key: string;
  max: number;
}

export type AttemptResult =
  { ok: true; lockedNow: string[]; ticket: string } | { ok: false; retryAfterMs: number };

function takeStatement(db: Db, { key, max }: AttemptKey, now: number, ticket: string) {
  return db.get<{ locked_until: number | null; last_ticket: string | null; failures: number }>(sql`
    INSERT INTO auth_attempts (key, failures, locks, locked_until, last_ticket, updated_at)
    VALUES (${key}, 1, 0, NULL, ${ticket}, ${now})
    ON CONFLICT(key) DO UPDATE SET
      failures = CASE WHEN locked_until > ${now} THEN failures
                      WHEN failures + 1 >= ${max} THEN 0 ELSE failures + 1 END,
      locks = CASE WHEN locked_until > ${now} THEN locks
                   WHEN failures + 1 >= ${max} THEN locks + 1 ELSE locks END,
      locked_until = CASE WHEN locked_until > ${now} THEN locked_until
                          WHEN failures + 1 >= ${max}
                            THEN ${now} + ${LOCKOUT_BASE_MS} * (1 << min(locks, ${MAX_DOUBLINGS}))
                          ELSE locked_until END,
      last_ticket = CASE WHEN locked_until > ${now} THEN last_ticket ELSE ${ticket} END,
      updated_at = ${now}
    RETURNING failures, locked_until, last_ticket`);
}

/**
 * Count one attempt against every key, in two phases:
 * 1. read every key; if any is locked, refuse WITHOUT counting anything (so a refused request
 *    can never push another key, e.g. a shared one, towards its limit);
 * 2. count atomically per key; a key that reached its limit in a race refuses the attempt.
 * `lockedNow` lists keys this attempt just locked. `ticket` is passed to `attemptSucceeded`.
 */
export async function takeAttempt(db: Db, keys: AttemptKey[], now: number): Promise<AttemptResult> {
  const existing = await db
    .select({ lockedUntil: authAttempts.lockedUntil })
    .from(authAttempts)
    .where(
      inArray(
        authAttempts.key,
        keys.map((k) => k.key),
      ),
    )
    .all();
  const lockedUntil = existing.map((r) => r.lockedUntil ?? 0).filter((u) => u > now);
  if (lockedUntil.length) return { ok: false, retryAfterMs: Math.max(...lockedUntil) - now };

  const ticket = randomHex(8);
  const rows = await Promise.all(keys.map((k) => takeStatement(db, k, now, ticket)));
  const blocked = rows.filter((r) => r.last_ticket !== ticket);
  if (blocked.length > 0) {
    return { ok: false, retryAfterMs: Math.max(...blocked.map((r) => (r.locked_until ?? now) - now), 1) };
  }
  const lockedNow = keys.filter((_, i) => (rows[i]!.locked_until ?? 0) > now).map((k) => k.key);
  return { ok: true, lockedNow, ticket };
}

/**
 * After a success: forget the name's history entirely. Shared keys (the IP) get the attempt back
 * and their escalation reset; their lock is lifted only if this very attempt set it, so a valid
 * account can't be used to unlock an IP someone else locked.
 */
export async function attemptSucceeded(
  db: Db,
  clear: string[],
  refund: string[],
  ticket: string,
): Promise<void> {
  await Promise.all([
    ...clear.map((key) => db.delete(authAttempts).where(eq(authAttempts.key, key))),
    ...refund.map((key) =>
      db
        .update(authAttempts)
        .set({
          failures: sql`max(${authAttempts.failures} - 1, 0)`,
          locks: 0,
          lockedUntil: sql`CASE WHEN ${authAttempts.lastTicket} = ${ticket} THEN NULL ELSE ${authAttempts.lockedUntil} END`,
        })
        .where(eq(authAttempts.key, key)),
    ),
  ]);
}

export async function clearAttempts(db: Db, keys: string[]): Promise<void> {
  if (keys.length) await db.delete(authAttempts).where(inArray(authAttempts.key, keys));
}

/**
 * Rate-limit key for a client address. IPv4 is cut to its /24 and IPv6 to its /64 before hashing:
 * one IPv6 client controls a whole /64, and a truncated address can't be reversed to a person.
 */
export async function ipKeyFor(address: string | undefined): Promise<string> {
  const ip = address ?? 'unknown';
  let prefix = ip;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) prefix = ip.split('.').slice(0, 3).join('.') + '.0/24';
  else if (ip.includes(':')) prefix = expandIpv6(ip).slice(0, 4).join(':') + '::/64';
  return `ip:${await sha256Hex(prefix)}`;
}

function expandIpv6(ip: string): string[] {
  const [head = '', tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = Math.max(0, 8 - h.length - t.length); // malformed input must not throw
  const groups = ip.includes('::') ? [...h, ...Array<string>(fill).fill('0'), ...t] : h;
  return groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''));
}
