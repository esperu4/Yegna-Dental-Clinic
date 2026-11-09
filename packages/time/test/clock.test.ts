import { describe, expect, it } from 'vitest';
import {
  ET_PERIODS,
  formatEtTime,
  formatLocalTime,
  fromEtTime,
  localDateOf,
  localToUtc,
  periodLabel,
  periodOf,
  toEtTime,
  utcToLocal,
} from '../src/index.ts';

describe('PRD §6 ET clock examples', () => {
  it.each([
    [9 * 60, '3:00 ጠዋት', '3:00 morning'],
    [12 * 60, '6:00 ቀትር', '6:00 midday'],
    [13 * 60, '7:00 ከሰዓት', '7:00 afternoon'],
    [18 * 60, '12:00 ማታ', '12:00 evening'],
  ])('local %i min → %s', (min, am, en) => {
    expect(formatEtTime(min, 'am')).toBe(am);
    expect(formatEtTime(min, 'en')).toBe(en);
  });
});

describe('ET clock', () => {
  it('maps every local minute to ET and back', () => {
    for (let m = 0; m < 1440; m++) {
      const t = toEtTime(m);
      expect(t.hour).toBeGreaterThanOrEqual(1);
      expect(t.hour).toBeLessThanOrEqual(12);
      expect(fromEtTime(t)).toBe(m);
    }
  });

  it('handles the 12-o-clock edges', () => {
    expect(toEtTime(0)).toEqual({ hour: 6, minute: 0, period: 'night' });
    expect(toEtTime(6 * 60)).toEqual({ hour: 12, minute: 0, period: 'morning' });
    expect(toEtTime(6 * 60 + 59)).toEqual({ hour: 12, minute: 59, period: 'morning' });
    expect(toEtTime(7 * 60)).toEqual({ hour: 1, minute: 0, period: 'morning' });
    expect(toEtTime(1439)).toEqual({ hour: 5, minute: 59, period: 'evening' });
  });

  it('rejects out-of-range input', () => {
    for (const bad of [-1, 1440, 10.5]) {
      expect(() => toEtTime(bad)).toThrow(RangeError);
      expect(() => periodOf(bad)).toThrow(RangeError);
      expect(() => formatLocalTime(bad)).toThrow(RangeError);
    }
    expect(() => fromEtTime({ hour: 0, minute: 0, period: 'morning' })).toThrow(RangeError);
    expect(() => fromEtTime({ hour: 13, minute: 0, period: 'morning' })).toThrow(RangeError);
    expect(() => fromEtTime({ hour: 3, minute: 60, period: 'morning' })).toThrow(RangeError);
    expect(() => fromEtTime({ hour: 3, minute: -1, period: 'morning' })).toThrow(RangeError);
    expect(() => fromEtTime({ hour: 3.5, minute: 0, period: 'morning' })).toThrow(RangeError);
    expect(() => fromEtTime({ hour: 3, minute: 0.5, period: 'morning' })).toThrow(RangeError);
    // 3:00 ET is 09:00 or 21:00; neither is midday.
    expect(() => fromEtTime({ hour: 3, minute: 0, period: 'midday' })).toThrow(/not in period/);
  });

  it('has one label table covering the whole day', () => {
    expect(ET_PERIODS[0]!.from).toBe(0);
    expect(periodLabel('night', 'am')).toBe('ሌሊት');
    expect(formatLocalTime(9 * 60 + 5)).toBe('09:05');
  });
});

describe('Addis Ababa zone (UTC+3, no DST)', () => {
  it('converts UTC instants to local date and minutes', () => {
    // 2026-11-09T06:00Z = 09:00 local
    expect(utcToLocal(Date.UTC(2026, 10, 9, 6, 0))).toEqual({ date: '2026-11-09', minutes: 540 });
    // 21:30Z is already the next local day
    expect(utcToLocal(Date.UTC(2026, 10, 9, 21, 30, 59))).toEqual({ date: '2026-11-10', minutes: 30 });
    expect(localDateOf(Date.UTC(1969, 11, 31, 22, 0))).toBe('1970-01-01');
  });

  it('converts local back to UTC and round-trips across a year with no DST jump', () => {
    expect(localToUtc('2026-11-09', 540)).toBe(Date.UTC(2026, 10, 9, 6, 0));
    for (let d = 0; d < 366; d += 7) {
      const ms = Date.UTC(2026, 0, 1 + d, 8, 15);
      const l = utcToLocal(ms);
      expect(localToUtc(l.date, l.minutes)).toBe(ms);
      expect(l.minutes).toBe(11 * 60 + 15);
    }
  });
});
