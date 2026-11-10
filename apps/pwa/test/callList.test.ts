import { describe, expect, it } from 'vitest';
import type { BookingRow, PatientRow } from '@yegna/shared/client';
import { localToUtc } from '@yegna/time';
import { approvalsByDay, callList, callListRange } from '../src/lib/callList.ts';

// Monday 16 Nov 2026, 10:00 in Addis Ababa.
const NOW = localToUtc('2026-11-16', 10 * 60);
const at = (date: string, hh: number) => localToUtc(date, hh * 60);
const meta = { version: 1, updatedAt: 0, updatedBy: null, deletedAt: null };

function booking(id: string, startAt: number, over: Partial<BookingRow> = {}): BookingRow {
  return {
    id,
    patientId: 'linked',
    procedureId: null,
    startAt,
    durationMin: 30,
    status: 'approved',
    approvedBy: null,
    approvedAt: null,
    patientConfirmedAt: null,
    callHandledAt: null,
    callHandledBy: null,
    callTriedAt: null,
    source: 'app',
    cancelReason: null,
    clashWithId: null,
    note: null,
    createdBy: 'u1',
    ...meta,
    ...over,
  };
}

const patient = (id: string, telegramLinked: boolean): PatientRow => ({
  id,
  name: id,
  phoneE164: '+251911000000',
  note: null,
  telegramLinked,
  ...meta,
});
const patients = new Map([
  ['linked', patient('linked', true)],
  ['phoneOnly', patient('phoneOnly', false)],
]);

describe('callList (PRD §8 item 8)', () => {
  it("lists tomorrow's patients without Telegram, and bookings unapproved within 24 h", () => {
    const items = callList(
      [
        booking('tomorrow-no-tg', at('2026-11-17', 9), { patientId: 'phoneOnly' }),
        booking('tomorrow-tg', at('2026-11-17', 11)),
        booking('unapproved-soon', at('2026-11-17', 8), { status: 'pending_approval' }),
        booking('unapproved-later', at('2026-11-17', 11), { status: 'pending_approval' }),
        booking('day-after-no-tg', at('2026-11-18', 9), { patientId: 'phoneOnly' }),
      ],
      patients,
      NOW,
    );
    expect(items.map((i) => [i.booking.id, i.reasons])).toEqual([
      ['unapproved-soon', ['unapproved']],
      ['tomorrow-no-tg', ['noTelegram']],
    ]);
  });

  it('gives one row with both reasons, soonest first', () => {
    const items = callList(
      [booking('both', at('2026-11-17', 9), { patientId: 'phoneOnly', status: 'pending_approval' })],
      patients,
      NOW,
    );
    expect(items[0]!.reasons).toEqual(['noTelegram', 'unapproved']);
  });

  it('leaves out handled, past, cancelled and clash bookings, but keeps an unanswered call', () => {
    const items = callList(
      [
        booking('handled', at('2026-11-17', 9), { patientId: 'phoneOnly', callHandledAt: NOW }),
        booking('tried', at('2026-11-17', 9), { patientId: 'phoneOnly', callTriedAt: NOW }),
        booking('past', NOW - 60_000, { status: 'pending_approval' }),
        booking('cancelled', at('2026-11-17', 9), { patientId: 'phoneOnly', status: 'cancelled' }),
        booking('clash', at('2026-11-17', 9), { patientId: 'phoneOnly', status: 'clash' }),
      ],
      patients,
      NOW,
    );
    expect(items.map((i) => i.booking.id)).toEqual(['tried']);
  });

  it('skips bookings of an erased patient (nobody to call)', () => {
    const deleted = new Map([['gone', { ...patient('gone', false), deletedAt: 1 }]]);
    expect(callList([booking('b', at('2026-11-17', 9), { patientId: 'gone' })], deleted, NOW)).toEqual([]);
  });

  it('brings a booking back when still unapproved 24 h before, even if a call was handled earlier', () => {
    const start = at('2026-11-17', 17);
    const handledEarly = booking('early', start, {
      status: 'pending_approval',
      patientId: 'phoneOnly',
      callHandledAt: NOW - 60_000,
    });
    // 10:00 today: the visit is 31 h away; the earlier call handled the 📵 reason.
    expect(callList([handledEarly], patients, NOW)).toEqual([]);
    // 17:00 today: 24 h before, still unapproved.
    const later = start - 24 * 60 * 60_000;
    expect(callList([handledEarly], patients, later).map((i) => i.reasons)).toEqual([['unapproved']]);
    // Handled again after the 24 h mark: off the list.
    const handledLate = { ...handledEarly, callHandledAt: later };
    expect(callList([handledLate], patients, later + 60_000)).toEqual([]);
  });

  it('reads bookings from now to the end of tomorrow', () => {
    expect(callListRange(NOW)).toEqual([NOW, localToUtc('2026-11-18', 0)]);
  });
});

describe('approvalsByDay (PRD §8 item 7)', () => {
  it('groups upcoming bookings waiting for approval by clinic day', () => {
    const groups = approvalsByDay(
      [
        booking('b2', at('2026-11-18', 9), { status: 'pending_approval' }),
        booking('b1', at('2026-11-17', 14), { status: 'pending_approval' }),
        booking('b0', at('2026-11-17', 9), { status: 'pending_approval' }),
        booking('approved', at('2026-11-17', 10)),
        booking('past', NOW - 1, { status: 'pending_approval' }),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.date, g.bookings.map((b) => b.id)])).toEqual([
      ['2026-11-17', ['b0', 'b1']],
      ['2026-11-18', ['b2']],
    ]);
  });
});
