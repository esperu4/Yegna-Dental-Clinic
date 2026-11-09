import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysInEthiopianMonth,
  daysInGregorianMonth,
  formatEthiopianDate,
  formatIsoDate,
  gregorianToJdn,
  isEthiopianLeapYear,
  isGregorianLeapYear,
  isValidEthiopian,
  jdnToGregorian,
  parseIsoDate,
  toEthiopian,
  toGregorian,
  weekdayOf,
} from '../src/index.ts';

describe('PRD §6 required fixtures', () => {
  it.each([
    ['2026-09-11', { year: 2019, month: 1, day: 1 }],
    ['2026-11-09', { year: 2019, month: 2, day: 30 }],
    ['2027-09-12', { year: 2020, month: 1, day: 1 }],
  ])('%s GC = %o EC', (gc, ec) => {
    expect(toEthiopian(parseIsoDate(gc))).toEqual(ec);
    expect(formatIsoDate(toGregorian(ec))).toBe(gc);
  });

  it('2019 EC is a leap year: Pagume has 6 days', () => {
    expect(isEthiopianLeapYear(2019)).toBe(true);
    expect(daysInEthiopianMonth(2019, 13)).toBe(6);
    expect(formatIsoDate(toGregorian({ year: 2019, month: 13, day: 6 }))).toBe('2027-09-11');
  });

  it('round-trips GC → EC → GC for every day 2020–2035', () => {
    let iso = '2020-01-01';
    let prev = toEthiopian(parseIsoDate(iso));
    let days = 0;
    while (iso <= '2035-12-31') {
      const g = parseIsoDate(iso);
      const e = toEthiopian(g);
      expect(isValidEthiopian(e)).toBe(true);
      expect(toGregorian(e)).toEqual(g);
      if (days > 0) {
        // Ethiopian dates advance by exactly one day, rolling months/years correctly.
        const rolled =
          e.day === 1 &&
          (e.month === prev.month + 1 || (e.month === 1 && prev.month === 13 && e.year === prev.year + 1));
        expect(rolled || (e.year === prev.year && e.month === prev.month && e.day === prev.day + 1)).toBe(
          true,
        );
      }
      prev = e;
      iso = addDays(iso, 1);
      days++;
    }
    expect(days).toBe(5844);
  });
});

describe('Ethiopian calendar', () => {
  it('leap years are year mod 4 = 3, including negative years', () => {
    expect([2015, 2016, 2017, 2018, 2019].map(isEthiopianLeapYear)).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
    expect(isEthiopianLeapYear(-1)).toBe(true);
    expect(daysInEthiopianMonth(2018, 13)).toBe(5);
    expect(daysInEthiopianMonth(2018, 4)).toBe(30);
  });

  it('rejects invalid dates', () => {
    expect(isValidEthiopian({ year: 2018, month: 13, day: 6 })).toBe(false);
    expect(isValidEthiopian({ year: 2018, month: 0, day: 1 })).toBe(false);
    expect(isValidEthiopian({ year: 2018, month: 14, day: 1 })).toBe(false);
    expect(isValidEthiopian({ year: 2018, month: 1, day: 0 })).toBe(false);
    expect(isValidEthiopian({ year: 2018, month: 1, day: 31 })).toBe(false);
    expect(isValidEthiopian({ year: 2018.5, month: 1, day: 1 })).toBe(false);
    expect(isValidEthiopian({ year: 2018, month: 1.5, day: 1 })).toBe(false);
    expect(isValidEthiopian({ year: 2018, month: 1, day: 1.5 })).toBe(false);
    expect(() => toGregorian({ year: 2018, month: 13, day: 6 })).toThrow(RangeError);
  });

  it('formats in both languages', () => {
    const e = { year: 2019, month: 2, day: 30 };
    expect(formatEthiopianDate(e, 'am')).toBe('ጥቅምት 30, 2019');
    expect(formatEthiopianDate(e, 'en')).toBe('Tikimt 30, 2019');
    expect(() => formatEthiopianDate({ year: 2019, month: 14, day: 1 }, 'en')).toThrow(RangeError);
  });

  it('handles dates before the epoch cycle', () => {
    const g = { year: 5, month: 3, day: 1 };
    expect(toGregorian(toEthiopian(g))).toEqual(g);
  });
});

describe('Gregorian helpers', () => {
  it('leap years and month lengths', () => {
    expect([1900, 2000, 2024, 2026].map(isGregorianLeapYear)).toEqual([false, true, true, false]);
    expect(daysInGregorianMonth(2024, 2)).toBe(29);
    expect(daysInGregorianMonth(2026, 2)).toBe(28);
    expect(daysInGregorianMonth(2026, 4)).toBe(30);
    expect(daysInGregorianMonth(2026, 12)).toBe(31);
  });

  it('JDN round-trip and known value', () => {
    expect(gregorianToJdn({ year: 2000, month: 1, day: 1 })).toBe(2451545);
    expect(jdnToGregorian(2451545)).toEqual({ year: 2000, month: 1, day: 1 });
  });

  it('parses and rejects ISO dates', () => {
    expect(parseIsoDate('2026-11-09')).toEqual({ year: 2026, month: 11, day: 9 });
    for (const bad of ['2026-11-9', '2026-02-29', '2026-13-01', '2026-00-10', 'nope']) {
      expect(() => parseIsoDate(bad)).toThrow(RangeError);
    }
  });

  it('adds days across months and years, and gives weekdays', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekdayOf('2026-11-09')).toBe(1); // Monday
    expect(weekdayOf('2026-11-08')).toBe(0); // Sunday
    expect(formatIsoDate({ year: 33, month: 1, day: 2 })).toBe('0033-01-02');
  });
});
