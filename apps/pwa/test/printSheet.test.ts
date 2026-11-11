import { describe, expect, it } from 'vitest';
import { parseSheetId } from '@yegna/shared/client';
import { DEFAULT_WEEKLY_HOURS, type WeeklyDefaults } from '@yegna/time';
import { hourRows, mondayOf, sheetLayout } from '../src/lib/printSheet.ts';

const procedures = [
  { code: 'X', nameAm: 'ማውጣት', nameEn: 'Extraction' },
  { code: 'CL', nameAm: 'ማጽዳት', nameEn: 'Cleaning' },
];

describe('paper templates (PRD §11)', () => {
  it('prints hourly rows 3:00–12:00 ET with the lunch hour shaded (defaults)', () => {
    const rows = hourRows(DEFAULT_WEEKLY_HOURS, 'en');
    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual({ minutes: 9 * 60, label: '3:00 morning', lunch: false });
    expect(rows.at(-1)!.minutes).toBe(17 * 60);
    expect(rows.filter((r) => r.lunch).map((r) => r.minutes)).toEqual([12 * 60]);
  });

  it('follows the clinic hours: earliest opening to latest closing, rounded to whole hours', () => {
    const custom = [...DEFAULT_WEEKLY_HOURS] as unknown as WeekdayList;
    custom[6] = { openAt: 8 * 60 + 30, closeAt: 13 * 60, lunchStart: null, lunchEnd: null };
    const rows = hourRows(custom as unknown as WeeklyDefaults, 'en');
    expect(rows[0]!.minutes).toBe(8 * 60);
    expect(rows.at(-1)!.minutes).toBe(17 * 60);
    expect(hourRows([null, null, null, null, null, null, null], 'en')).toEqual([]);
  });

  it('F: one page Monday–Saturday with a sheet ID that names that week', () => {
    const sheet = sheetLayout({
      template: 'F',
      date: '2026-11-26',
      weeklyHours: DEFAULT_WEEKLY_HOURS,
      procedures,
      locale: 'en',
    });
    if (sheet.template === 'O') throw new Error('expected a week sheet');
    expect(sheet.pages).toHaveLength(1);
    expect(sheet.pages[0]!.id).toBe('YD-F-2019-T03W2');
    expect(parseSheetId(sheet.pages[0]!.id)).toMatchObject({ monday: '2026-11-23' });
    expect(sheet.pages[0]!.days.map((d) => d.iso)).toEqual([
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-26',
      '2026-11-27',
      '2026-11-28',
    ]);
    expect(sheet.pages[0]!.days[0]!.label).toBe('Monday · Hidar 14');
    expect(sheet.linesPerHour).toBe(3);
    // Legend sorted by code, in the chosen language.
    expect(sheet.legend).toEqual([
      { code: 'CL', name: 'Cleaning' },
      { code: 'X', name: 'Extraction' },
    ]);
  });

  it('C: two pages a week, Mon–Wed and Thu–Sat', () => {
    const sheet = sheetLayout({
      template: 'C',
      date: '2026-11-23',
      weeklyHours: DEFAULT_WEEKLY_HOURS,
      procedures,
      locale: 'am',
    });
    if (sheet.template === 'O') throw new Error('expected a week sheet');
    expect(sheet.pages.map((p) => p.id)).toEqual(['YD-C-2019-T03W2-1', 'YD-C-2019-T03W2-2']);
    expect(sheet.pages.map((p) => p.days.length)).toEqual([3, 3]);
    expect(sheet.legend[0]).toEqual({ code: 'CL', name: 'ማጽዳት' });
  });

  it('O: one Ethiopian month, Monday–Saturday columns, Sundays left out', () => {
    const sheet = sheetLayout({
      template: 'O',
      date: '2026-11-20',
      weeklyHours: DEFAULT_WEEKLY_HOURS,
      procedures,
      locale: 'en',
    });
    if (sheet.template !== 'O') throw new Error('expected the month sheet');
    expect(sheet.id).toBe('YD-O-2019-T03');
    expect(sheet.title).toBe('Hidar 2019');
    const cells = sheet.weeks.flat().filter((c) => c !== null);
    expect(cells[0]).toMatchObject({ etDay: 1 });
    expect(cells.at(-1)!.etDay).toBe(30);
    // Hidar 2019 runs 2026-11-10 … 2026-12-09: 30 days, 4 of them Sundays.
    expect(cells[0]!.iso).toBe('2026-11-10');
    expect(cells.length).toBe(26);
    // Hidar 1 is a Tuesday: the first week starts with an empty Monday.
    expect(sheet.weeks[0]![0]).toBeNull();
    for (const week of sheet.weeks) expect(week).toHaveLength(6);
    expect(sheet.linesPerDay).toBe(6);
  });

  it('a closed weekday prints without entry lines', () => {
    const closedSaturday = [...DEFAULT_WEEKLY_HOURS] as unknown as WeekdayList;
    closedSaturday[6] = null;
    const sheet = sheetLayout({
      template: 'F',
      date: '2026-11-23',
      weeklyHours: closedSaturday as unknown as WeeklyDefaults,
      procedures,
      locale: 'en',
    });
    if (sheet.template === 'O') throw new Error('expected a week sheet');
    expect(sheet.pages[0]!.days.map((d) => d.closed)).toEqual([false, false, false, false, false, true]);
  });

  it('finds the Monday of any day of the week (Sunday belongs to the week before)', () => {
    expect(mondayOf('2026-11-23')).toBe('2026-11-23');
    expect(mondayOf('2026-11-28')).toBe('2026-11-23');
    expect(mondayOf('2026-11-29')).toBe('2026-11-23');
  });
});

type WeekdayList = (WeeklyDefaults[number] | null)[];
