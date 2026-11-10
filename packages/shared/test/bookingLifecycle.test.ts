import { describe, expect, it } from 'vitest';
import {
  NO_SHOW_AFTER_MS,
  isActiveStatus,
  statusAfterReschedule,
  statusOnCreate,
  checkStatusChange,
} from '../src/bookingLifecycle.ts';
import { BOOKING_STATUSES, type BookingStatus } from '../src/enums.ts';

const START = Date.UTC(2026, 10, 12, 7, 0); // 10:00 Addis Ababa

describe('statusOnCreate (PRD §10, §21 #1)', () => {
  it('auto-approves bookings created by the Doctor', () => {
    expect(statusOnCreate('doctor')).toBe('approved');
  });
  it('sends Staff bookings for approval', () => {
    expect(statusOnCreate('staff')).toBe('pending_approval');
  });
});

describe('checkStatusChange', () => {
  const ok = (from: BookingStatus, to: BookingStatus, role: 'doctor' | 'staff' = 'staff', now = START) =>
    checkStatusChange({ from, to, role, startAt: START, now, cancelReason: 'patient asked' });

  it('lets only the Doctor approve', () => {
    expect(ok('pending_approval', 'approved', 'doctor')).toBeNull();
    expect(ok('pending_approval', 'approved', 'staff')).toBe('forbidden');
  });

  it('follows the lifecycle diagram', () => {
    expect(ok('approved', 'arrived')).toBeNull();
    expect(ok('arrived', 'done')).toBeNull();
    expect(ok('pending_approval', 'cancelled')).toBeNull();
    expect(ok('approved', 'cancelled')).toBeNull();
    expect(ok('clash', 'cancelled')).toBeNull();
  });

  it.each<[BookingStatus, BookingStatus]>([
    ['pending_approval', 'arrived'],
    ['pending_approval', 'done'],
    ['pending_approval', 'no_show'],
    ['approved', 'done'],
    ['approved', 'pending_approval'],
    ['arrived', 'cancelled'],
    ['done', 'approved'],
    ['cancelled', 'approved'],
    ['no_show', 'arrived'],
    // A clash is fixed by moving the booking (statusAfterReschedule), not by a status change.
    ['clash', 'pending_approval'],
    ['clash', 'approved'],
  ])('refuses %s → %s', (from, to) => {
    expect(ok(from, to, 'doctor')).toBe('invalid_transition');
  });

  it('refuses a change to the same status', () => {
    for (const s of BOOKING_STATUSES) expect(ok(s, s, 'doctor')).toBe('invalid_transition');
  });

  it('requires a reason to cancel', () => {
    for (const cancelReason of [null, '', '   ']) {
      expect(
        checkStatusChange({
          from: 'approved',
          to: 'cancelled',
          role: 'staff',
          startAt: START,
          now: START,
          cancelReason,
        }),
      ).toBe('reason_required');
    }
  });

  it('allows no-show only from 20 minutes after the start (PRD §21 #5)', () => {
    expect(NO_SHOW_AFTER_MS).toBe(20 * 60_000);
    expect(ok('approved', 'no_show', 'staff', START + NO_SHOW_AFTER_MS - 1)).toBe('too_early');
    expect(ok('approved', 'no_show', 'staff', START + NO_SHOW_AFTER_MS)).toBeNull();
  });
});

describe('statusAfterReschedule (PRD §10, §21 #2)', () => {
  it('sends an approved booking moved by Staff back for approval', () => {
    expect(statusAfterReschedule('approved', 'staff')).toBe('pending_approval');
  });
  it('keeps an approved booking moved by the Doctor approved', () => {
    expect(statusAfterReschedule('approved', 'doctor')).toBe('approved');
  });
  it('fixes a clash: Staff → pending approval, Doctor → approved', () => {
    expect(statusAfterReschedule('clash', 'staff')).toBe('pending_approval');
    expect(statusAfterReschedule('clash', 'doctor')).toBe('approved');
  });
  it('keeps a pending booking pending', () => {
    expect(statusAfterReschedule('pending_approval', 'staff')).toBe('pending_approval');
    expect(statusAfterReschedule('pending_approval', 'doctor')).toBe('pending_approval');
  });
  it.each<BookingStatus>(['arrived', 'done', 'cancelled', 'no_show'])('refuses to move a %s booking', (s) => {
    expect(statusAfterReschedule(s, 'doctor')).toBeNull();
  });
});

describe('isActiveStatus', () => {
  it('counts only pending_approval, approved and arrived (PRD §7.4)', () => {
    expect(BOOKING_STATUSES.filter(isActiveStatus)).toEqual(['pending_approval', 'approved', 'arrived']);
  });
});
