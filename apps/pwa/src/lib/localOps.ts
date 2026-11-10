/**
 * Applying an op to the device's copy of a row (PRD §7.2). Pure, so the same function serves
 * the optimistic write and the replay of still-pending ops on top of fresh server rows.
 */
import {
  type CallOutcome,
  type Role,
  type SyncOp,
  statusAfterReschedule,
  statusOnCreate,
} from '@yegna/shared/client';

type AnyRow = Record<string, unknown>;

/** Defaults the server fills in on create, so a new row is complete on the device too. */
function createDefaults(op: SyncOp, role: Role): AnyRow {
  switch (op.entity) {
    case 'patients':
      return { note: null, telegramLinked: false };
    case 'bookings': {
      const status = statusOnCreate(role);
      return {
        note: null,
        status,
        approvedBy: status === 'approved' ? op.userId : null,
        approvedAt: status === 'approved' ? op.at : null,
        patientConfirmedAt: null,
        callHandledAt: null,
        callHandledBy: null,
        callTriedAt: null,
        source: 'app',
        cancelReason: null,
        clashWithId: null,
        createdBy: op.userId,
      };
    }
    default:
      return {};
  }
}

/**
 * The row after `op`, marked provisional. Mirrors the server's rules where the UI shows the
 * result (booking status after create or a move); the server's answer replaces it on sync.
 */
export function applyLocally(current: object | undefined, op: SyncOp, role: Role): AnyRow {
  const row = current as AnyRow | undefined;
  const stamp = { updatedAt: op.at, updatedBy: op.userId, provisional: true };
  const key = op.entity === 'dayRules' ? { date: op.entityId } : { id: op.entityId };

  if (op.kind === 'delete') return { ...row, ...stamp, deletedAt: op.at } as never;
  if (!row) {
    return {
      ...createDefaults(op, role),
      ...op.fields,
      ...key,
      version: 0,
      deletedAt: null,
      ...stamp,
    } as never;
  }

  const { call, callFor, ...fields } = op.fields as { call?: CallOutcome; callFor?: number } & AnyRow;
  const next: AnyRow = { ...row, ...fields, ...stamp, deletedAt: null };
  if (op.entity === 'bookings') {
    // Call-list outcome (ADR 0008): the same marks the server sets, and only where it accepts
    // them (a booking still coming up, at the time the call was about).
    const callable =
      (row.status === 'pending_approval' || row.status === 'approved') && row.startAt === callFor;
    if (call && callable) {
      if (call === 'no_answer') next.callTriedAt = op.at;
      else Object.assign(next, { callHandledAt: op.at, callHandledBy: op.userId });
      if (call === 'confirmed') next.patientConfirmedAt = op.at;
    }
    // Same rule as the server: a needs_fixing booking sent with its own time is re-checked in place.
    const recheck =
      row.status === 'needs_fixing' &&
      (op.fields.startAt !== undefined || op.fields.durationMin !== undefined);
    const moved =
      recheck ||
      (op.fields.startAt !== undefined && op.fields.startAt !== row.startAt) ||
      (op.fields.durationMin !== undefined && op.fields.durationMin !== row.durationMin);
    if (moved) {
      const status = statusAfterReschedule(row.status as never, role);
      if (status) {
        Object.assign(next, { status, clashWithId: null });
        // A new start time needs a new confirmation and call (ADR 0008).
        if (op.fields.startAt !== undefined && op.fields.startAt !== row.startAt) {
          Object.assign(next, {
            patientConfirmedAt: null,
            callHandledAt: null,
            callHandledBy: null,
            callTriedAt: null,
          });
        }
      }
    }
    if (op.fields.status === 'approved') Object.assign(next, { approvedBy: op.userId, approvedAt: op.at });
  }
  return next as never;
}
