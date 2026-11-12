import { describe, expect, it } from 'vitest';
import { DEFAULT_WEEKLY_HOURS } from '@yegna/time';
import { isDuplicate, nameSimilarity, parseEtTime, rowDate, rowStart } from '../src/importMatch.ts';

describe('reading a row’s day (PRD §12)', () => {
  const week = { template: 'F' as const, monday: '2026-11-23' };
  it('maps weekday columns of a week sheet to dates, in English or Amharic', () => {
    expect(rowDate(week, 'mon')).toBe('2026-11-23');
    expect(rowDate(week, 'Saturday')).toBe('2026-11-28');
    expect(rowDate(week, 'ረቡዕ')).toBe('2026-11-25');
    expect(rowDate(week, 'sun')).toBeNull(); // not on the sheet
    expect(rowDate(week, undefined)).toBeNull();
  });

  it('keeps page 2 of template C to Thursday–Saturday', () => {
    const page2 = { template: 'C' as const, monday: '2026-11-23', page: 2 as const };
    expect(rowDate(page2, 'thu')).toBe('2026-11-26');
    expect(rowDate(page2, 'mon')).toBeNull();
  });

  it('maps a day of the Ethiopian month on the month sheet', () => {
    const month = { template: 'O' as const, etYear: 2019, etMonth: 3 };
    expect(rowDate(month, '1')).toBe('2026-11-10');
    expect(rowDate(month, '30')).toBe('2026-12-09');
    expect(rowDate(month, '31')).toBeNull();
    expect(rowDate(month, 'x')).toBeNull();
  });
});

describe('reading an ET time (PRD §6)', () => {
  it('reads H, H:MM and H.MM and returns local minutes within clinic hours', () => {
    // 3:00 ET in the morning = 09:00; 4:30 = 10:30; 11:45 = 17:45.
    expect(parseEtTime('3:00', DEFAULT_WEEKLY_HOURS[1])).toBe(9 * 60);
    expect(parseEtTime('4.30', DEFAULT_WEEKLY_HOURS[1])).toBe(10 * 60 + 30);
    expect(parseEtTime(' 11:45 ', DEFAULT_WEEKLY_HOURS[1])).toBe(17 * 60 + 45);
    expect(parseEtTime('5', DEFAULT_WEEKLY_HOURS[1])).toBe(11 * 60);
  });

  it('refuses times that are unreadable or outside the clinic day', () => {
    expect(parseEtTime('2:00', DEFAULT_WEEKLY_HOURS[1])).toBeNull(); // 08:00, before opening
    expect(parseEtTime('4:75', DEFAULT_WEEKLY_HOURS[1])).toBeNull();
    expect(parseEtTime('noon', DEFAULT_WEEKLY_HOURS[1])).toBeNull();
    expect(parseEtTime('4:00', null)).toBeNull(); // closed weekday
    expect(parseEtTime(undefined, DEFAULT_WEEKLY_HOURS[1])).toBeNull();
  });

  it('combines day and time into the booking start (UTC), snapped to the 15-minute grid', () => {
    const week = { template: 'F' as const, monday: '2026-11-23' };
    // Monday 4:10 ET → 10:10 local → snapped to 10:15 → 07:15 UTC.
    expect(rowStart(week, { day: 'mon', time: '4:10' }, DEFAULT_WEEKLY_HOURS)).toEqual({
      date: '2026-11-23',
      startAt: Date.UTC(2026, 10, 23, 7, 15),
      snapped: true,
    });
    expect(rowStart(week, { day: 'mon', time: '4:00' }, DEFAULT_WEEKLY_HOURS)).toMatchObject({
      snapped: false,
    });
    expect(rowStart(week, { day: 'mon', time: '1:00' }, DEFAULT_WEEKLY_HOURS)).toBeNull();
    expect(rowStart(null, { day: 'mon', time: '4:00' }, DEFAULT_WEEKLY_HOURS)).toBeNull();
  });
});

describe('matching (PRD §12)', () => {
  it('scores names that differ by a letter or spacing as similar, in any script', () => {
    expect(nameSimilarity('Abebe Kebede', 'abebe  kebede')).toBe(1);
    expect(nameSimilarity('Abebe Kebede', 'Abebe Kebde')).toBeGreaterThan(0.85);
    expect(nameSimilarity('አበበ ከበደ', 'አበበ ከበደ')).toBe(1);
    expect(nameSimilarity('Abebe Kebede', 'Hana Tesfaye')).toBeLessThan(0.5);
    expect(nameSimilarity('', 'x')).toBe(0);
  });

  it('calls it a duplicate when the same patient is booked within ±30 minutes that day', () => {
    const at = Date.UTC(2026, 10, 23, 7, 0);
    expect(isDuplicate(at, [{ startAt: at + 30 * 60_000 }])).toBe(true);
    expect(isDuplicate(at, [{ startAt: at - 30 * 60_000 }])).toBe(true);
    expect(isDuplicate(at, [{ startAt: at + 45 * 60_000 }])).toBe(false);
    expect(isDuplicate(at, [])).toBe(false);
  });
});
