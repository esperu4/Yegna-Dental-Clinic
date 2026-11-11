/**
 * Sheet IDs on the paper templates (PRD §11), printed large and as a QR code, and read back from
 * photos to know which dates a sheet covers.
 *
 * - Week sheets (F, C): `YD-F-2019-T03W2` — template, Ethiopian year, Ethiopian month of the
 *   sheet's Monday, and that Monday's week of the month (days 1–7 ⇒ W1, 8–14 ⇒ W2, …). Template C
 *   prints two pages a week: `-1` (Mon–Wed) and `-2` (Thu–Sat).
 * - Month sheet (O): `YD-O-2019-T03`.
 */
import {
  addDays,
  daysInEthiopianMonth,
  formatIsoDate,
  parseIsoDate,
  toEthiopian,
  toGregorian,
  weekdayOf,
} from '@yegna/time';

export type SheetTemplate = 'F' | 'C' | 'O';

export type SheetRef =
  | { template: 'F'; monday: string; page?: undefined }
  | { template: 'C'; monday: string; page?: 1 | 2 }
  | { template: 'O'; etYear: number; etMonth: number };

type SheetIdInput =
  | { template: 'F'; monday: string }
  | { template: 'C'; monday: string; page: 1 | 2 }
  | { template: 'O'; etYear: number; etMonth: number };

const pad2 = (n: number) => String(n).padStart(2, '0');

export function sheetIdFor(sheet: SheetIdInput): string {
  if (sheet.template === 'O') return `YD-O-${sheet.etYear}-T${pad2(sheet.etMonth)}`;
  const et = toEthiopian(parseIsoDate(sheet.monday));
  const base = `YD-${sheet.template}-${et.year}-T${pad2(et.month)}W${Math.floor((et.day - 1) / 7) + 1}`;
  return sheet.template === 'C' ? `${base}-${sheet.page}` : base;
}

const PATTERN = /^YD([FCO])(\d{4})T(\d{2})(?:W(\d))?(?:([12]))?$/;

/** The sheet an ID names, or `null`. Tolerates case, spaces and missing dashes. */
export function parseSheetId(raw: string | undefined | null): SheetRef | null {
  if (!raw) return null;
  const m = PATTERN.exec(raw.toUpperCase().replace(/[\s-]/g, ''));
  if (!m) return null;
  const [, template, yearText, monthText, weekText, pageText] = m;
  const year = Number(yearText);
  const month = Number(monthText);
  if (month < 1 || month > 13) return null;
  if (template === 'O') return weekText || pageText ? null : { template: 'O', etYear: year, etMonth: month };
  if (!weekText) return null;
  if (template === 'F' && pageText) return null;
  const monday = mondayOf(year, month, Number(weekText));
  if (!monday) return null;
  if (template === 'F') return { template: 'F', monday, page: undefined };
  return pageText ? { template: 'C', monday, page: Number(pageText) as 1 | 2 } : { template: 'C', monday };
}

/** The Monday in days (w−1)·7+1 … w·7 of the Ethiopian month, if there is one. */
function mondayOf(year: number, month: number, week: number): string | null {
  const last = daysInEthiopianMonth(year, month);
  for (let day = (week - 1) * 7 + 1; day <= Math.min(week * 7, last); day++) {
    const iso = formatIsoDate(toGregorian({ year, month, day }));
    if (weekdayOf(iso) === 1) return iso;
  }
  return null;
}

/** The Gregorian dates (inclusive) a sheet covers: Monday–Saturday, half of it, or the month. */
export function sheetPeriod(sheet: SheetRef): { from: string; to: string } {
  if (sheet.template === 'O') {
    const last = daysInEthiopianMonth(sheet.etYear, sheet.etMonth);
    return {
      from: formatIsoDate(toGregorian({ year: sheet.etYear, month: sheet.etMonth, day: 1 })),
      to: formatIsoDate(toGregorian({ year: sheet.etYear, month: sheet.etMonth, day: last })),
    };
  }
  if (sheet.template === 'C' && sheet.page === 2) {
    return { from: addDays(sheet.monday, 3), to: addDays(sheet.monday, 5) };
  }
  if (sheet.template === 'C' && sheet.page === 1) {
    return { from: sheet.monday, to: addDays(sheet.monday, 2) };
  }
  return { from: sheet.monday, to: addDays(sheet.monday, 5) };
}
