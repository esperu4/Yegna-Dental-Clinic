/**
 * Sends a message at most once per (kind, key, chat), using `notification_log` (PRD §5, §16).
 *
 * A send first claims its row: a new row, a failed one, or one left `pending` by a run that died
 * mid-send (after `STALE_PENDING_MS`). Only the run whose claim changed a row sends, so running a
 * job twice, or two runs at once, sends nothing twice. The log keeps ids and the outcome only,
 * never the text (it may hold patient names; PRD §18).
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { notificationLog } from '@yegna/db';
import { uuidv7 } from '@yegna/shared';
import type { Db } from '../lib/db.ts';
import { type Notifier, type OutgoingMessage, PermanentSendError, sendErrorKind } from './notifier.ts';

/** A pending row older than this belongs to a run that never finished; it may be claimed again. */
export const STALE_PENDING_MS = 30 * 60_000;

export interface NotificationKey {
  kind: string;
  /** A booking id, or another stable key (e.g. `day:2026-11-17`); '' if there is none. */
  key: string;
  chatId: string;
}

export type DeliveryResult = 'sent' | 'skipped' | 'failed' | 'dropped';

export async function deliverOnce(
  db: Db,
  notifier: Notifier,
  target: NotificationKey,
  render: () => OutgoingMessage | Promise<OutgoingMessage>,
  now: number,
): Promise<DeliveryResult> {
  if (!(await claim(db, target, now))) return 'skipped';
  const where = keyed(target);
  try {
    await notifier.send(target.chatId, await render());
  } catch (err) {
    console.error('notify_failed', target.kind, sendErrorKind(err));
    const status = err instanceof PermanentSendError ? 'dropped' : 'failed';
    await db.update(notificationLog).set({ status }).where(where).run();
    return status;
  }
  await db.update(notificationLog).set({ status: 'sent', sentAt: now }).where(where).run();
  return 'sent';
}

/** True if this run now owns the row (and must send). `sentAt` holds the claim time until sent. */
async function claim(db: Db, target: NotificationKey, now: number): Promise<boolean> {
  const inserted = await db
    .insert(notificationLog)
    .values({
      id: uuidv7(now),
      kind: target.kind,
      bookingId: target.key,
      targetChatId: target.chatId,
      status: 'pending',
      sentAt: now,
    })
    .onConflictDoNothing()
    .run();
  if (inserted.meta.changes > 0) return true;
  const retaken = await db
    .update(notificationLog)
    .set({ status: 'pending', sentAt: now })
    .where(
      and(
        keyed(target),
        or(
          eq(notificationLog.status, 'failed'),
          and(
            eq(notificationLog.status, 'pending'),
            sql`${notificationLog.sentAt} < ${now - STALE_PENDING_MS}`,
          ),
        ),
      ),
    )
    .run();
  return retaken.meta.changes > 0;
}

function keyed({ kind, key, chatId }: NotificationKey) {
  return and(
    eq(notificationLog.kind, kind),
    eq(notificationLog.bookingId, key),
    eq(notificationLog.targetChatId, chatId),
  );
}

/** D1 allows 100 bound values per statement. */
const CHUNK = 90;
const chunks = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** Keys of `kind` already sent to `chatId` among `keys` (e.g. bookings already in a digest). */
export async function sentKeys(db: Db, kind: string, chatId: string, keys: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunks(keys, CHUNK - 3)) {
    const rows = await db
      .select({ key: notificationLog.bookingId })
      .from(notificationLog)
      .where(
        and(
          eq(notificationLog.kind, kind),
          eq(notificationLog.targetChatId, chatId),
          eq(notificationLog.status, 'sent'),
          inArray(notificationLog.bookingId, part),
        ),
      )
      .all();
    for (const r of rows) found.add(r.key);
  }
  return found;
}

/** Records `keys` as sent without sending (items shown inside a message sent under another key). */
export async function markSent(db: Db, kind: string, chatId: string, keys: string[], now: number) {
  // Six values per row: one statement per 15 rows.
  for (const part of chunks(keys, 15)) {
    await db
      .insert(notificationLog)
      .values(
        part.map((key) => ({
          id: uuidv7(now),
          kind,
          bookingId: key,
          targetChatId: chatId,
          status: 'sent' as const,
          sentAt: now,
        })),
      )
      .onConflictDoNothing()
      .run();
  }
}
