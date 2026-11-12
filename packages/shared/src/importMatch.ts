/**
 * Turning a read sheet row into a booking candidate (PRD §12): which date its column means, which
 * local time its ET time means, how alike two names are, and whether it duplicates a booking.
 * Pure, so the server's matching and the review screen agree.
 */
import {
  GRID_STEP_MIN,
  type WeekdayHours,
  type WeeklyDefaults,
  addDays,
  daysInEthiopianMonth,
  formatIsoDate,
  localToUtc,
  toGregorian,
  weekdayName,
  weekdayOf,
} from '@yegna/time';
import { type SheetRef, sheetPeriod } from './sheetId.ts';

/** Weekday words as readers and people write them, to the offset from Monday. */
const WEEKDAY_WORDS: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  const short = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  short.forEach((s, i) => (map[s] = i));
  for (let i = 0; i < 6; i++) {
    const weekday = ((i + 1) % 7) as 1 | 2 | 3 | 4 | 5 | 6;
    map[weekdayName(weekday, 'en').toLowerCase()] = i;
    map[weekdayName(weekday, 'am')] = i;
  }
  return map;
})();

/** The date a row's `day` means on this sheet, or `null` if it is not a day of the sheet. */
export function rowDate(sheet: SheetRef, day: string | undefined): string | null {
  if (!day) return null;
  const text = day.trim();
  if (sheet.template === 'O') {
    if (!/^\d{1,2}$/.test(text)) return null;
    const etDay = Number(text);
    if (etDay < 1 || etDay > daysInEthiopianMonth(sheet.etYear, sheet.etMonth)) return null;
    return formatIsoDate(toGregorian({ year: sheet.etYear, month: sheet.etMonth, day: etDay }));
  }
  const offset = WEEKDAY_WORDS[text.toLowerCase()] ?? WEEKDAY_WORDS[text];
  if (offset === undefined) return null;
  const date = addDays(sheet.monday, offset);
  const { from, to } = sheetPeriod(sheet);
  return date >= from && date <= to ? date : null;
}

/**
 * Local minutes for an ET time written on the sheet (`4`, `4:30`, `4.30`), choosing the reading
 * that falls inside the day's opening hours; `null` if unreadable, or outside them.
 */
export function parseEtTime(text: string | undefined, hours: WeekdayHours | null): number | null {
  if (!text || !hours) return null;
  const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const morning = ((hour + 6) % 12) * 60 + minute;
  for (const candidate of [morning, morning + 720]) {
    if (candidate >= hours.openAt && candidate < hours.closeAt) return candidate;
  }
  return null;
}

/**
 * The booking start a row means (UTC ms), snapped to the 15-minute grid; `snapped` tells the
 * review screen the time was adjusted. `null` when the sheet, day or time can't be read.
 */
export function rowStart(
  sheet: SheetRef | null,
  row: { day?: string | undefined; time?: string | undefined },
  weekly: WeeklyDefaults,
): { date: string; startAt: number; snapped: boolean } | null {
  if (!sheet) return null;
  const date = rowDate(sheet, row.day);
  if (!date) return null;
  const minutes = parseEtTime(row.time, weekly[weekdayOf(date)] ?? null);
  if (minutes === null) return null;
  const grid = Math.round(minutes / GRID_STEP_MIN) * GRID_STEP_MIN;
  return { date, startAt: localToUtc(date, grid), snapped: grid !== minutes };
}

function normalizeName(name: string): string {
  return name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s.,'’-]+/g, '');
}

/** 0–1: one minus the edit distance over the longer name (spaces, case and dots ignored). */
export function nameSimilarity(a: string, b: string): number {
  const x = [...normalizeName(a)];
  const y = [...normalizeName(b)];
  if (x.length === 0 || y.length === 0) return 0;
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[y.length]! / Math.max(x.length, y.length);
}

/** PRD §12: a booking for the same patient that day within ±30 minutes makes the row a duplicate. */
export const DUPLICATE_WINDOW_MS = 30 * 60_000;

export function isDuplicate(startAt: number, sameDayBookings: { startAt: number }[]): boolean {
  return sameDayBookings.some((b) => Math.abs(b.startAt - startAt) <= DUPLICATE_WINDOW_MS);
}
