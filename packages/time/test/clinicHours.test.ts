import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEEKLY_HOURS,
  bookingDuration,
  checkBooking,
  fixedHolidays,
  gridSlots,
  isMovableHolidayReminderDue,
  localToUtc,
  resolveDay,
  type DayRule,
} from '../src/index.ts';

const MON = '2026-11-09';
const SUN = '2026-11-08';
const open = resolveDay(MON, DEFAULT_WEEKLY_HOURS);

const rule = (over: Partial<DayRule>): DayRule => ({
  date: MON,
  closed: false,
  openAt: null,
  closeAt: null,
  lunchStart: null,
  lunchEnd: null,
  ...over,
});

describe('resolveDay', () => {
  it('uses weekly defaults: Mon–Sat 09:00–18:00, lunch 12–13, closed Sunday', () => {
    expect(open).toEqual({
      date: MON,
      closed: false,
      openAt: 540,
      closeAt: 1080,
      lunchStart: 720,
      lunchEnd: 780,
    });
    expect(resolveDay(SUN, DEFAULT_WEEKLY_HOURS)).toEqual({ date: SUN, closed: true, reason: 'weekly' });
  });

  it('holidays default to closed; an open holiday keeps weekly hours', () => {
    expect(resolveDay(MON, DEFAULT_WEEKLY_HOURS, null, { date: MON, closed: true })).toEqual({
      date: MON,
      closed: true,
      reason: 'holiday',
    });
    expect(resolveDay(MON, DEFAULT_WEEKLY_HOURS, null, { date: MON, closed: false })).toEqual(open);
  });

  it('day rule wins over holiday and weekly; null fields fall back', () => {
    expect(resolveDay(MON, DEFAULT_WEEKLY_HOURS, rule({ closeAt: 17 * 60 + 30 }))).toMatchObject({
      closeAt: 1050,
      openAt: 540,
    });
    expect(resolveDay(MON, DEFAULT_WEEKLY_HOURS, rule({ closed: true }))).toMatchObject({
      closed: true,
      reason: 'day_rule',
    });
    expect(resolveDay(MON, DEFAULT_WEEKLY_HOURS, rule({}), { date: MON, closed: true })).toMatchObject({
      closed: false,
    });
    // Opening a normally-closed Sunday falls back to standard hours.
    expect(
      resolveDay(SUN, DEFAULT_WEEKLY_HOURS, rule({ date: SUN, openAt: 600, lunchStart: 700, lunchEnd: 760 })),
    ).toEqual({
      date: SUN,
      closed: false,
      openAt: 600,
      closeAt: 1080,
      lunchStart: 700,
      lunchEnd: 760,
    });
  });
});

describe('checkBooking', () => {
  it('accepts a normal booking', () => {
    expect(checkBooking(open, 9 * 60, 60)).toEqual({ errors: [], warnings: [] });
    expect(checkBooking(open, 17 * 60, 60)).toEqual({ errors: [], warnings: [] }); // ends exactly at close
  });

  it('close time is hard', () => {
    expect(checkBooking(open, 17 * 60 + 15, 60).errors).toEqual(['after_close']);
    const early = resolveDay(MON, DEFAULT_WEEKLY_HOURS, rule({ closeAt: 17 * 60 + 30 }));
    expect(checkBooking(early, 17 * 60, 60).errors).toEqual(['after_close']);
    expect(checkBooking(open, 8 * 60 + 45, 30).errors).toEqual(['before_open']);
  });

  it('lunch is soft', () => {
    expect(checkBooking(open, 11 * 60 + 30, 60)).toEqual({ errors: [], warnings: ['lunch'] });
    expect(checkBooking(open, 13 * 60, 60).warnings).toEqual([]);
    expect(checkBooking(open, 11 * 60, 60).warnings).toEqual([]);
    const noLunch = resolveDay(MON, [
      null,
      { openAt: 540, closeAt: 1080, lunchStart: null, lunchEnd: null },
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(checkBooking(noLunch, 12 * 60, 60).warnings).toEqual([]);
  });

  it('blocks are hard', () => {
    const block = { startAt: localToUtc(MON, 14 * 60), endAt: localToUtc(MON, 15 * 60) };
    expect(checkBooking(open, 13 * 60 + 30, 60, [block]).errors).toEqual(['in_block']);
    expect(checkBooking(open, 15 * 60, 60, [block]).errors).toEqual([]);
    expect(checkBooking(open, 13 * 60, 60, [block]).errors).toEqual([]);
  });

  it('closed days and holidays are hard', () => {
    expect(checkBooking(resolveDay(SUN, DEFAULT_WEEKLY_HOURS), 600, 60).errors).toEqual(['closed_day']);
    expect(
      checkBooking(resolveDay(MON, DEFAULT_WEEKLY_HOURS, null, { date: MON, closed: true }), 600, 60).errors,
    ).toEqual(['holiday']);
  });

  it('enforces the 15-minute grid', () => {
    expect(checkBooking(open, 9 * 60 + 10, 60).errors).toEqual(['off_grid']);
    expect(checkBooking(open, 600, 50).errors).toEqual(['invalid_duration']);
    expect(checkBooking(open, 600, 0).errors).toEqual(['invalid_duration']);
    expect(checkBooking(open, 600.5, 60.5).errors).toEqual(['invalid_duration', 'off_grid']);
  });
});

describe('grid and durations', () => {
  it('lists 15-minute start slots between open and close', () => {
    const slots = gridSlots(open);
    expect(slots[0]).toBe(540);
    expect(slots.at(-1)).toBe(1065);
    expect(slots).toHaveLength(36);
    expect(gridSlots(resolveDay(SUN, DEFAULT_WEEKLY_HOURS))).toEqual([]);
    const odd = resolveDay(MON, DEFAULT_WEEKLY_HOURS, rule({ openAt: 545 }));
    expect(gridSlots(odd)[0]).toBe(555);
  });

  it('unspecified procedure = 60 min', () => {
    expect(bookingDuration(null)).toBe(60);
    expect(bookingDuration(undefined, 45)).toBe(45);
    expect(bookingDuration(30)).toBe(30);
  });
});

describe('holidays', () => {
  it('seeds fixed-date public holidays for an EC year in date order', () => {
    expect(fixedHolidays(2019).map((h) => [h.date, h.name_en])).toEqual([
      ['2026-09-11', 'Ethiopian New Year'],
      ['2026-09-27', 'Meskel'],
      ['2027-01-07', 'Ethiopian Christmas'],
      ['2027-01-19', 'Timket'],
      ['2027-03-02', 'Adwa Victory Day'],
      ['2027-05-01', 'Labour Day'],
      ['2027-05-05', "Patriots' Victory Day"],
      ['2027-05-28', 'Downfall of the Derg'],
    ]);
    // After the 2019 EC leap year, New Year and Meskel move a day later in GC.
    expect(
      fixedHolidays(2020)
        .slice(0, 2)
        .map((h) => h.date),
    ).toEqual(['2027-09-12', '2027-09-28']);
    expect(fixedHolidays(2020).every((h) => h.closed && h.name_am.length > 0)).toBe(true);
  });

  it('reminds about movable holidays during Meskerem only', () => {
    expect(isMovableHolidayReminderDue('2026-09-11')).toBe(true);
    expect(isMovableHolidayReminderDue('2026-10-10')).toBe(true);
    expect(isMovableHolidayReminderDue('2026-10-11')).toBe(false);
  });
});
