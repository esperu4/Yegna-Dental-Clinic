/**
 * Booking lifecycle (PRD §10, §9). Pure rules shared by the API (enforced in `/sync`) and the PWA
 * (mirrored in the UI, so the buttons shown are the ones the server accepts).
 *
 * ```
 * (device) provisional ─sync─▶ pending_approval ─doctor─▶ approved ─▶ arrived ─▶ done
 *                       └overlap▶ clash ─moved─▶ pending_approval
 *                       └outside hours▶ needs_fixing ─moved─▶ pending_approval
 * pending_approval / approved ─▶ cancelled (reason)        approved ─▶ no_show
 * ```
 */
import { type BookingStatus, CLASH_STATUSES, type Role } from './enums.ts';

/** No-show can be marked from 20 minutes after the start (PRD §10, §21 #5). */
export const NO_SHOW_AFTER_MS = 20 * 60_000;

/** Statuses a user may set directly. `clash`, `needs_fixing` and `pending_approval` are only ever set by the server. */
const TRANSITIONS: Readonly<Partial<Record<BookingStatus, readonly BookingStatus[]>>> = {
  pending_approval: ['approved', 'cancelled'],
  approved: ['arrived', 'cancelled', 'no_show'],
  arrived: ['done'],
  clash: ['cancelled'],
  needs_fixing: ['cancelled'],
};

export type StatusChangeError = 'invalid_transition' | 'forbidden' | 'reason_required' | 'too_early';

export function isActiveStatus(status: BookingStatus): boolean {
  return (CLASH_STATUSES as readonly BookingStatus[]).includes(status);
}

/** Bookings created by the Doctor are approved automatically (PRD §21 #1). */
export function statusOnCreate(role: Role): BookingStatus {
  return role === 'doctor' ? 'approved' : 'pending_approval';
}

/** Whether `role` may move a booking from `from` to `to` now. Returns null when allowed. */
export function checkStatusChange(input: {
  from: BookingStatus;
  to: BookingStatus;
  role: Role;
  startAt: number;
  now: number;
  cancelReason: string | null | undefined;
}): StatusChangeError | null {
  const { from, to, role } = input;
  if (!TRANSITIONS[from]?.includes(to)) return 'invalid_transition';
  if (to === 'approved' && role !== 'doctor') return 'forbidden';
  if (to === 'cancelled' && !input.cancelReason?.trim()) return 'reason_required';
  if (to === 'no_show' && input.now < input.startAt + NO_SHOW_AFTER_MS) return 'too_early';
  return null;
}

/**
 * Status after the date, time or duration changes, or null if the booking can no longer be moved.
 * Moving an approved booking sends it back for approval unless the Doctor moved it (PRD §21 #2);
 * moving a clash or needs-fixing booking is how it is fixed. The server then re-runs its checks.
 */
export function statusAfterReschedule(current: BookingStatus, role: Role): BookingStatus | null {
  switch (current) {
    case 'pending_approval':
      return 'pending_approval';
    case 'approved':
    case 'clash':
    case 'needs_fixing':
      return statusOnCreate(role);
    default:
      return null;
  }
}
