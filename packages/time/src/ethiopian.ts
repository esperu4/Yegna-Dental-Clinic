import { type GDate, gregorianToJdn, jdnToGregorian } from './gregorian.ts';

/** A date in the Ethiopian calendar (Amete Mihret era). `month` is 1–13 (13 = Pagume). */
export interface EDate {
  year: number;
  month: number;
  day: number;
}

/** JDN of the day before Meskerem 1, year 1 EC, minus one 365-day year (Amete Mihret epoch, 1723856). */
const EPOCH = 1723856;

export const ETHIOPIAN_MONTHS = [
  { am: 'መስከረም', en: 'Meskerem' },
  { am: 'ጥቅምት', en: 'Tikimt' },
  { am: 'ኅዳር', en: 'Hidar' },
  { am: 'ታኅሣሥ', en: 'Tahsas' },
  { am: 'ጥር', en: 'Tir' },
  { am: 'የካቲት', en: 'Yekatit' },
  { am: 'መጋቢት', en: 'Megabit' },
  { am: 'ሚያዝያ', en: 'Miyazya' },
  { am: 'ግንቦት', en: 'Ginbot' },
  { am: 'ሰኔ', en: 'Sene' },
  { am: 'ሐምሌ', en: 'Hamle' },
  { am: 'ነሐሴ', en: 'Nehase' },
  { am: 'ጳጉሜ', en: 'Pagume' },
] as const;

/** An Ethiopian year is leap (Pagume has 6 days) when year mod 4 = 3. */
export function isEthiopianLeapYear(year: number): boolean {
  return ((year % 4) + 4) % 4 === 3;
}

export function daysInEthiopianMonth(year: number, month: number): number {
  if (month < 13) return 30;
  return isEthiopianLeapYear(year) ? 6 : 5;
}

export function isValidEthiopian(d: EDate): boolean {
  return (
    Number.isInteger(d.year) &&
    Number.isInteger(d.month) &&
    Number.isInteger(d.day) &&
    d.month >= 1 &&
    d.month <= 13 &&
    d.day >= 1 &&
    d.day <= daysInEthiopianMonth(d.year, d.month)
  );
}

export function ethiopianToJdn({ year, month, day }: EDate): number {
  return EPOCH + 365 + 365 * (year - 1) + Math.floor(year / 4) + 30 * month + day - 31;
}

export function jdnToEthiopian(jdn: number): EDate {
  const r = (((jdn - EPOCH) % 1461) + 1461) % 1461;
  const n = (r % 365) + 365 * Math.floor(r / 1460);
  return {
    year: 4 * Math.floor((jdn - EPOCH) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460),
    month: Math.floor(n / 30) + 1,
    day: (n % 30) + 1,
  };
}

export function toEthiopian(g: GDate): EDate {
  return jdnToEthiopian(gregorianToJdn(g));
}

export function toGregorian(e: EDate): GDate {
  if (!isValidEthiopian(e)) throw new RangeError(`Invalid Ethiopian date: ${e.year}-${e.month}-${e.day}`);
  return jdnToGregorian(ethiopianToJdn(e));
}

/** e.g. `ጥቅምት 30, 2019` / `Tikimt 30, 2019`. */
export function formatEthiopianDate(e: EDate, locale: 'am' | 'en'): string {
  const month = ETHIOPIAN_MONTHS[e.month - 1];
  if (!month) throw new RangeError(`Invalid Ethiopian month: ${e.month}`);
  return `${month[locale]} ${e.day}, ${e.year}`;
}
