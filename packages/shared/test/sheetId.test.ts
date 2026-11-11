import { describe, expect, it } from 'vitest';
import { addDays, toEthiopian, parseIsoDate, weekdayOf } from '@yegna/time';
import { parseSheetId, sheetIdFor, sheetPeriod } from '../src/sheetId.ts';

describe('sheet IDs (PRD §11)', () => {
  it('names a week sheet by template, Ethiopian year, month and week of the month', () => {
    // 2026-11-16 is a Monday: Hidar 7, 2019 ET (month 3), so week 1 of Hidar.
    expect(sheetIdFor({ template: 'F', monday: '2026-11-16' })).toBe('YD-F-2019-T03W1');
    expect(sheetIdFor({ template: 'F', monday: '2026-11-23' })).toBe('YD-F-2019-T03W2');
    // Template C prints two pages per week.
    expect(sheetIdFor({ template: 'C', monday: '2026-11-23', page: 2 })).toBe('YD-C-2019-T03W2-2');
    // Template O is a month.
    expect(sheetIdFor({ template: 'O', etYear: 2019, etMonth: 3 })).toBe('YD-O-2019-T03');
  });

  it('round-trips every Monday of several years to the same week', () => {
    let monday = '2025-09-08';
    while (weekdayOf(monday) !== 1) monday = addDays(monday, 1);
    for (let i = 0; i < 52 * 4; i++, monday = addDays(monday, 7)) {
      const id = sheetIdFor({ template: 'F', monday });
      expect(parseSheetId(id)).toEqual({ template: 'F', monday, page: undefined });
      expect(parseSheetId(sheetIdFor({ template: 'C', monday, page: 1 }))).toEqual({
        template: 'C',
        monday,
        page: 1,
      });
    }
  });

  it('reads IDs the way people and AI write them back', () => {
    expect(parseSheetId('YD-C-2019-T03W2')).toEqual({ template: 'C', monday: '2026-11-23' });
    expect(parseSheetId(' yd-f-2019-t03w2 ')).toEqual({
      template: 'F',
      monday: '2026-11-23',
      page: undefined,
    });
    expect(parseSheetId('YD F 2019 T03 W2')).toEqual({
      template: 'F',
      monday: '2026-11-23',
      page: undefined,
    });
    expect(parseSheetId('YD-O-2019-T03')).toEqual({ template: 'O', etYear: 2019, etMonth: 3 });
  });

  it('refuses IDs that name no real sheet', () => {
    for (const bad of [
      'YD-X-2019-T03W2',
      'YD-F-2019-T14W1',
      'YD-F-2019-T03W6',
      'YD-F-2019-T03',
      'YD-O-2019-T03W1',
      'YD-C-2019-T03W2-3',
      'YD-F-2019-T13W2', // Pagume has only one week
      'nonsense',
      undefined,
    ]) {
      expect(parseSheetId(bad)).toBeNull();
    }
  });

  it('gives the Gregorian dates a sheet covers', () => {
    expect(sheetPeriod({ template: 'F', monday: '2026-11-23' })).toEqual({
      from: '2026-11-23',
      to: '2026-11-28',
    });
    expect(sheetPeriod({ template: 'C', monday: '2026-11-23', page: 2 })).toEqual({
      from: '2026-11-26',
      to: '2026-11-28',
    });
    const month = sheetPeriod({ template: 'O', etYear: 2019, etMonth: 3 });
    expect(toEthiopian(parseIsoDate(month.from))).toEqual({ year: 2019, month: 3, day: 1 });
    expect(toEthiopian(parseIsoDate(month.to))).toEqual({ year: 2019, month: 3, day: 30 });
  });
});
