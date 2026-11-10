import { describe, expect, it } from 'vitest';
import type { BlockRow, BookingRow, PatientRow } from '@yegna/shared/client';
import { DEFAULT_WEEKLY_HOURS, localToUtc } from '@yegna/time';
import { phoneDigits, searchByName, searchByPhone } from '../src/lib/patientSearch.ts';
import { cardActions, checkDraft, nextFreeSlot, planDay } from '../src/lib/schedule.ts';

const MONDAY = '2026-11-16';
const SUNDAY = '2026-11-15';
const meta = { version: 1, updatedAt: 0, updatedBy: null, deletedAt: null };
const at = (date: string, hh: number, mm = 0) => localToUtc(date, hh * 60 + mm);

function booking(id: string, startAt: number, over: Partial<BookingRow> = {}): BookingRow {
  return {
    id,
    patientId: 'p1',
    procedureId: null,
    startAt,
    durationMin: 60,
    status: 'approved',
    approvedBy: null,
    approvedAt: null,
    patientConfirmedAt: null,
    source: 'app',
    cancelReason: null,
    clashWithId: null,
    note: null,
    createdBy: 'u1',
    ...meta,
    ...over,
  };
}

const block = (startAt: number, endAt: number): BlockRow => ({
  id: 'bl',
  startAt,
  endAt,
  reason: null,
  ...meta,
});

function plan(over: { bookings?: BookingRow[]; blocks?: BlockRow[]; date?: string } = {}) {
  return planDay({
    date: over.date ?? MONDAY,
    weekly: DEFAULT_WEEKLY_HOURS,
    dayRule: undefined,
    holidays: [],
    blocks: over.blocks ?? [],
    bookings: over.bookings ?? [],
  });
}

describe('planDay', () => {
  it('keeps the day’s bookings in time order, leaves out cancelled ones, and counts them', () => {
    const p = plan({
      bookings: [
        booking('b2', at(MONDAY, 11), { status: 'arrived' }),
        booking('b1', at(MONDAY, 9), { status: 'done' }),
        booking('b3', at(MONDAY, 14), { status: 'cancelled' }),
        booking('other-day', at(SUNDAY, 10)),
        booking('deleted', at(MONDAY, 15), { deletedAt: 1 }),
      ],
    });
    expect(p.bookings.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(p.counts).toEqual({ booked: 2, arrived: 1, done: 1 });
  });

  it('applies a closed holiday and day rules', () => {
    const holiday = { id: 'h', date: MONDAY, nameAm: 'በዓል', nameEn: 'Holiday', closed: true, ...meta };
    const p = planDay({
      date: MONDAY,
      weekly: DEFAULT_WEEKLY_HOURS,
      dayRule: undefined,
      holidays: [holiday],
      blocks: [],
      bookings: [],
    });
    expect(p.day).toMatchObject({ closed: true, reason: 'holiday' });
    expect(p.holiday?.nameEn).toBe('Holiday');
    const early = planDay({
      date: MONDAY,
      weekly: DEFAULT_WEEKLY_HOURS,
      dayRule: {
        date: MONDAY,
        openAt: null,
        closeAt: 690,
        lunchStart: null,
        lunchEnd: null,
        closed: false,
        note: null,
        ...meta,
      },
      holidays: [holiday],
      blocks: [],
      bookings: [],
    });
    expect(early.day).toMatchObject({ closed: false, closeAt: 690 });
  });
});

describe('checkDraft', () => {
  it('reports hard errors, the lunch warning and a live clash', () => {
    const p = plan({
      bookings: [booking('b1', at(MONDAY, 10))],
      blocks: [block(at(MONDAY, 15), at(MONDAY, 16))],
    });
    expect(checkDraft(p, { startMin: 17 * 60 + 30, durationMin: 60 }).errors).toEqual(['after_close']);
    expect(checkDraft(p, { startMin: 15 * 60, durationMin: 30 }).errors).toEqual(['in_block']);
    expect(checkDraft(p, { startMin: 12 * 60, durationMin: 60 })).toEqual({
      errors: [],
      warnings: ['lunch'],
      clashWith: null,
    });
    expect(checkDraft(p, { startMin: 10 * 60 + 30, durationMin: 30 }).clashWith?.id).toBe('b1');
    // Moving the booking itself does not clash with itself; back-to-back is fine.
    expect(checkDraft(p, { startMin: 10 * 60 + 30, durationMin: 30, bookingId: 'b1' }).clashWith).toBeNull();
    expect(checkDraft(p, { startMin: 11 * 60, durationMin: 60 }).clashWith).toBeNull();
  });

  it('ignores done and no-show bookings in the clash warning', () => {
    const p = plan({ bookings: [booking('b1', at(MONDAY, 10), { status: 'done' })] });
    expect(checkDraft(p, { startMin: 600, durationMin: 60 }).clashWith).toBeNull();
  });
});

describe('nextFreeSlot', () => {
  it('finds the first slot that fits, skipping bookings and blocks', () => {
    const p = plan({
      bookings: [booking('b1', at(MONDAY, 9))],
      blocks: [block(at(MONDAY, 10), at(MONDAY, 11))],
    });
    expect(nextFreeSlot(p, 60)).toBe(11 * 60);
    expect(nextFreeSlot(p, 30, 11 * 60 + 15)).toBe(11 * 60 + 15);
    expect(nextFreeSlot(plan({ date: SUNDAY }), 60)).toBeNull();
  });
});

describe('cardActions', () => {
  const start = at(MONDAY, 10);
  it('offers the lifecycle actions the server accepts (PRD §8 item 6, §10)', () => {
    expect(cardActions({ status: 'pending_approval', startAt: start }, 'staff', start)).toEqual([
      'reschedule',
      'cancel',
      'call',
      'bookNext',
    ]);
    expect(cardActions({ status: 'pending_approval', startAt: start }, 'doctor', start)).toEqual([
      'approve',
      'reschedule',
      'cancel',
      'call',
      'bookNext',
    ]);
    expect(cardActions({ status: 'approved', startAt: start }, 'staff', start)).toEqual([
      'arrived',
      'reschedule',
      'cancel',
      'call',
      'bookNext',
    ]);
    expect(cardActions({ status: 'arrived', startAt: start }, 'staff', start)).toEqual([
      'done',
      'call',
      'bookNext',
    ]);
    expect(cardActions({ status: 'done', startAt: start }, 'doctor', start)).toEqual(['call', 'bookNext']);
  });

  it('offers no-show from 20 minutes after the start', () => {
    expect(cardActions({ status: 'approved', startAt: start }, 'staff', start + 19 * 60_000)).not.toContain(
      'noShow',
    );
    expect(cardActions({ status: 'approved', startAt: start }, 'staff', start + 20 * 60_000)).toContain(
      'noShow',
    );
  });
});

describe('patient search', () => {
  const patient = (id: string, name: string, phoneE164: string): PatientRow => ({
    id,
    name,
    phoneE164,
    note: null,
    telegramLinked: false,
    ...meta,
  });
  const patients = [
    patient('1', 'Abebe Kebede', '+251911234567'),
    patient('2', 'ሐና በቀለ', '+251911555123'),
    patient('3', 'Hana Tesfaye', '+251722234500'),
    { ...patient('4', 'Deleted', '+251911234999'), deletedAt: 5 },
  ];

  it('reads the national number from what is typed', () => {
    expect(phoneDigits('0911 23')).toBe('91123');
    expect(phoneDigits('+251 91')).toBe('91');
    expect(phoneDigits('911')).toBe('911');
  });

  it('suggests by phone from 4 digits, prefix matches first, never deleted patients', () => {
    expect(searchByPhone(patients, '091')).toEqual([]);
    expect(searchByPhone(patients, '0911').map((p) => p.id)).toEqual(['1', '2']);
    expect(searchByPhone(patients, '5551').map((p) => p.id)).toEqual(['2']);
    // A match at the start of the number ranks above one in the middle.
    expect(searchByPhone(patients, '9112').map((p) => p.id)).toEqual(['1']);
    expect(
      searchByPhone([patients[2]!, patient('5', 'Zed', '+251911722234')], '7222').map((p) => p.id),
    ).toEqual(['3', '5']);
    expect(
      searchByPhone([patient('5', 'Abel', '+251911722234'), patients[2]!], '7222').map((p) => p.id),
    ).toEqual(['3', '5']);
  });

  it('searches names in Ge’ez and Latin script, ignoring case', () => {
    expect(searchByName(patients, 'hana').map((p) => p.id)).toEqual(['3']);
    expect(searchByName(patients, 'ሐና').map((p) => p.id)).toEqual(['2']);
    expect(searchByName(patients, 'KEBEDE').map((p) => p.id)).toEqual(['1']);
    expect(searchByName(patients, 'a')).toEqual([]);
  });
});
