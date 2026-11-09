import { auditLog } from '@yegna/db';
import { uuidv7 } from '@yegna/shared';
import type { Db } from './db.ts';
import type { Session } from './http.ts';

/** Builds an `audit_log` insert. Never put PIN hashes or tokens in `diff`. */
export function auditInsert(
  db: Db,
  session: Pick<Session, 'deviceId'> & { user: { id: string } },
  entity: string,
  entityId: string,
  action: string,
  diff: Record<string, unknown> | null,
  at: number,
) {
  return db.insert(auditLog).values({
    id: uuidv7(at),
    entity,
    entityId,
    userId: session.user.id,
    deviceId: session.deviceId,
    action,
    diff: diff ? JSON.stringify(diff) : null,
    at,
  });
}

/**
 * Records that rate-limit keys were just locked (no user or device: the caller is unknown).
 * Keys are hashes (`enrol:<sha256>`, `ip:<sha256>`), never names or addresses.
 * The team bot will alert the Doctor from these rows (M3).
 */
export async function auditLockout(db: Db, keys: string[], at: number): Promise<void> {
  await db.insert(auditLog).values(
    keys.map((key) => ({
      id: uuidv7(at),
      entity: 'auth',
      entityId: key,
      userId: null,
      deviceId: null,
      action: 'lockout',
      diff: null,
      at,
    })),
  );
}
