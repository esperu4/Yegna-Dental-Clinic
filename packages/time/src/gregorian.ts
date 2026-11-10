/** A calendar date in the proleptic Gregorian calendar. `month` is 1–12. */
export interface GDate {
  year: number;
  month: number;
  day: number;
}

/** Day of week, 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isGregorianLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInGregorianMonth(year: number, month: number): number {
  if (month === 2) return isGregorianLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isValidGregorian(d: GDate): boolean {
  return (
    Number.isInteger(d.year) &&
    Number.isInteger(d.month) &&
    Number.isInteger(d.day) &&
    d.month >= 1 &&
    d.month <= 12 &&
    d.day >= 1 &&
    d.day <= daysInGregorianMonth(d.year, d.month)
  );
}

/** Julian Day Number of a Gregorian date (Fliegel–Van Flandern). */
export function gregorianToJdn({ year, month, day }: GDate): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return (
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

export function jdnToGregorian(jdn: number): GDate {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    day: e - Math.floor((153 * m + 2) / 5) + 1,
    month: m + 3 - 12 * Math.floor(m / 10),
    year: 100 * b + d - 4800 + Math.floor(m / 10),
  };
}

/** Parse `YYYY-MM-DD`. Throws on malformed or impossible dates. */
export function parseIsoDate(iso: string): GDate {
  const match = ISO_DATE.exec(iso);
  if (!match) throw new RangeError(`Invalid ISO date: ${iso}`);
  const d = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (!isValidGregorian(d)) throw new RangeError(`Invalid ISO date: ${iso}`);
  return d;
}

export function formatIsoDate({ year, month, day }: GDate): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addDays(iso: string, days: number): string {
  return formatIsoDate(jdnToGregorian(gregorianToJdn(parseIsoDate(iso)) + days));
}

export function weekdayOf(iso: string): Weekday {
  // JDN 0 was a Monday, so (jdn + 1) % 7 gives 0 = Sunday.
  return ((gregorianToJdn(parseIsoDate(iso)) + 1) % 7) as Weekday;
}

/** Weekday names, indexed like `Weekday` (0 = Sunday). The clinic week starts on Monday. */
const WEEKDAY_NAMES: Record<'am' | 'en', readonly string[]> = {
  am: ['እሑድ', 'ሰኞ', 'ማክሰኞ', 'ረቡዕ', 'ሐሙስ', 'ዓርብ', 'ቅዳሜ'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};

export function weekdayName(weekday: Weekday, locale: 'am' | 'en'): string {
  return WEEKDAY_NAMES[locale][weekday]!;
}

/** Weekdays in the order the clinic lists them: Monday first, Sunday last. */
export const CLINIC_WEEK: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0];
