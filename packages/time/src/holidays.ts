/**
 * Fixed-date Ethiopian public holidays (seed data for the `holidays` table) and the
 * yearly reminder to enter movable ones (Fasika, Siklet, Eid al-Fitr, Eid al-Adha, Mawlid).
 */
import { formatIsoDate, parseIsoDate } from './gregorian.ts';
import { toEthiopian, toGregorian } from './ethiopian.ts';

export interface HolidaySeed {
  /** Gregorian ISO date. */
  date: string;
  name_am: string;
  name_en: string;
  closed: true;
}

type Fixed =
  | { kind: 'ec'; month: number; day: number; am: string; en: string }
  | { kind: 'gc'; month: number; day: number; am: string; en: string };

/**
 * Most fixed holidays are fixed in the Ethiopian calendar. Genna, Timket and
 * Labour Day are celebrated on fixed Gregorian dates, so their EC date shifts
 * by a day in the year after an EC leap year.
 */
const FIXED: readonly Fixed[] = [
  { kind: 'ec', month: 1, day: 1, am: 'እንቁጣጣሽ', en: 'Ethiopian New Year' },
  { kind: 'ec', month: 1, day: 17, am: 'መስቀል', en: 'Meskel' },
  { kind: 'gc', month: 1, day: 7, am: 'ገና', en: 'Ethiopian Christmas' },
  { kind: 'gc', month: 1, day: 19, am: 'ጥምቀት', en: 'Timket' },
  { kind: 'ec', month: 6, day: 23, am: 'የዓድዋ ድል በዓል', en: 'Adwa Victory Day' },
  { kind: 'gc', month: 5, day: 1, am: 'የሠራተኞች ቀን', en: 'Labour Day' },
  { kind: 'ec', month: 8, day: 27, am: 'የአርበኞች ቀን', en: "Patriots' Victory Day" },
  { kind: 'ec', month: 9, day: 20, am: 'ደርግ የወደቀበት ቀን', en: 'Downfall of the Derg' },
];

/** Fixed-date public holidays falling in Ethiopian year `ecYear`, in date order. */
export function fixedHolidays(ecYear: number): HolidaySeed[] {
  return FIXED.map((h) => {
    const g =
      h.kind === 'ec'
        ? toGregorian({ year: ecYear, month: h.month, day: h.day })
        : // Gregorian Jan–Aug dates fall in the EC year that began the previous September.
          { year: ecYear + 8, month: h.month, day: h.day };
    return { date: formatIsoDate(g), name_am: h.am, name_en: h.en, closed: true as const };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

/** True during Meskerem (EC month 1): the app reminds the doctor to enter this year's movable holidays. */
export function isMovableHolidayReminderDue(localDate: string): boolean {
  return toEthiopian(parseIsoDate(localDate)).month === 1;
}
