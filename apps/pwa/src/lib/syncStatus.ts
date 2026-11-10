/**
 * What the sync status pill (PRD §7.6) and the sync notification (PRD §7.7) say. Pure functions,
 * so the window and the service worker show the same thing.
 */
import type { OpResult, WriteEntity } from '@yegna/shared/client';

/** The pill's four states (plus "not synced yet" before the first sync on this phone). */
export type PillState =
  | { kind: 'problem'; reason: string }
  | { kind: 'offline'; since: number }
  | { kind: 'waiting'; count: number; heldUntil: number | null }
  | { kind: 'synced'; at: number }
  | { kind: 'starting' };

export function pillState(input: {
  state: 'idle' | 'syncing' | 'offline' | 'error';
  lastError: string | null;
  offlineSince: number | null;
  pendingCount: number;
  lastSyncedAt: number | null;
  heldUntil: number | null;
}): PillState {
  // While a sync runs, keep showing the last known problem or offline state: a retry on a weak
  // connection can take up to 30 s, and the pill must not claim "Synced" meanwhile.
  if (input.lastError !== null && (input.state === 'error' || input.state === 'syncing')) {
    return { kind: 'problem', reason: input.lastError };
  }
  if (input.offlineSince !== null && (input.state === 'offline' || input.state === 'syncing')) {
    return { kind: 'offline', since: input.offlineSince };
  }
  if (input.pendingCount > 0)
    return { kind: 'waiting', count: input.pendingCount, heldUntil: input.heldUntil };
  return input.lastSyncedAt === null ? { kind: 'starting' } : { kind: 'synced', at: input.lastSyncedAt };
}

/** What one sync run did, for the notification: "Synced: 3 bookings sent · 2 new from Hana · 1 clash to fix". */
export interface SyncSummary {
  /** Distinct bookings of this device that reached the server. */
  bookingsSent: number;
  /** New bookings made by other people, by their user id (not edits, not the first fill). */
  fromOthers: Record<string, number>;
  /** Distinct bookings of this device that need fixing: clash, needs fixing, or refused. */
  toFix: number;
}

export const EMPTY_SUMMARY: SyncSummary = { bookingsSent: 0, fromOthers: {}, toFix: 0 };

/** Running totals of one sync run; counts distinct bookings, not ops. */
export class SummaryBuilder {
  private sent = new Set<string>();
  private fix = new Set<string>();
  private others: Record<string, number> = {};

  /** Adds one response. `sent` maps opId → the op's entity and row id. */
  add(input: {
    results: readonly OpResult[];
    sent: ReadonlyMap<string, { entity: WriteEntity; entityId: string }>;
    newFromOthers: Readonly<Record<string, number>>;
  }): void {
    for (const r of input.results) {
      const op = input.sent.get(r.opId);
      if (op?.entity !== 'bookings') continue;
      if (r.outcome !== 'rejected') this.sent.add(op.entityId);
      if (r.outcome !== 'applied') this.fix.add(op.entityId);
    }
    for (const [userId, n] of Object.entries(input.newFromOthers)) {
      this.others[userId] = (this.others[userId] ?? 0) + n;
    }
  }

  get summary(): SyncSummary {
    return { bookingsSent: this.sent.size, fromOthers: { ...this.others }, toFix: this.fix.size };
  }
}

export function somethingHappened(s: SyncSummary): boolean {
  return s.bookingsSent > 0 || s.toFix > 0 || Object.keys(s.fromOthers).length > 0;
}

/** Where tapping the notification should go (PRD §7.7): bookings to fix first, then approvals, else Today. */
export function notificationTarget(s: SyncSummary, isDoctor: boolean): 'fix' | 'approvals' | 'today' {
  if (s.toFix > 0) return 'fix';
  if (isDoctor && Object.keys(s.fromOthers).length > 0) return 'approvals';
  return 'today';
}
