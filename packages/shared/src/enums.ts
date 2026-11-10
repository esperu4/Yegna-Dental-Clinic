/** Shared vocabulary (PRD §2, §5, §10). Keep these names identical in code, UI and commits. */

export const ROLES = ['doctor', 'staff'] as const;
export type Role = (typeof ROLES)[number];

export const LOCALES = ['am', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const CALENDARS = ['ethiopian', 'gregorian'] as const;
export type CalendarPref = (typeof CALENDARS)[number];

/**
 * Booking statuses stored on the server (PRD §10). `provisional` is device-only:
 * a booking in the outbox that the server has not accepted yet.
 */
export const BOOKING_STATUSES = [
  'pending_approval',
  'clash',
  /**
   * Saved, but it breaks a hard clinic-hours rule that changed after it was made (the day was
   * closed early, a block was added). Kept so nothing promised to a patient disappears; Staff move
   * it to a valid time. Takes no time in the clash check (decided 2026-11-10, docs/adr/0007).
   */
  'needs_fixing',
  'approved',
  'arrived',
  'done',
  'cancelled',
  'no_show',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Only these statuses occupy time in a clash check (PRD §7). */
export const CLASH_STATUSES = [
  'pending_approval',
  'approved',
  'arrived',
] as const satisfies readonly BookingStatus[];

export const BOOKING_SOURCES = ['app', 'import'] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

export const PATIENT_REQUEST_KINDS = ['reschedule', 'cancel'] as const;
export const PATIENT_REQUEST_STATUSES = ['open', 'handled'] as const;

export const IMPORT_STATUSES = ['queued', 'read', 'reviewed', 'failed'] as const;
export const IMPORT_ROW_MATCHES = ['existing', 'new', 'duplicate', 'unreadable'] as const;
export const IMPORT_ROW_DECISIONS = ['accept', 'skip'] as const;

export const PATIENT_NOTE_MAX = 280;
