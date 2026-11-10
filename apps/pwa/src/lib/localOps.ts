/**
 * Applying an op to the device's copy of a row (PRD §7.2). Pure, so the same function serves
 * the optimistic write and the replay of still-pending ops on top of fresh server rows.
 */
import { type Role, type SyncOp, statusAfterReschedule, statusOnCreate } from '@yegna/shared/client';

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

  const next: AnyRow = { ...row, ...op.fields, ...stamp, deletedAt: null };
  if (op.entity === 'bookings') {
    const moved =
      (op.fields.startAt !== undefined && op.fields.startAt !== row.startAt) ||
      (op.fields.durationMin !== undefined && op.fields.durationMin !== row.durationMin);
    if (moved) {
      const status = statusAfterReschedule(row.status as never, role);
      if (status) Object.assign(next, { status, clashWithId: null });
    }
    if (op.fields.status === 'approved') Object.assign(next, { approvedBy: op.userId, approvedAt: op.at });
  }
  return next as never;
}
