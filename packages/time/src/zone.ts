import { formatIsoDate, gregorianToJdn, jdnToGregorian, parseIsoDate } from './gregorian.ts';

/** IANA name of the clinic timezone. */
export const CLINIC_TIMEZONE = 'Africa/Addis_Ababa';
/** Africa/Addis_Ababa is UTC+3 all year (no DST), so conversion is plain arithmetic. */
export const CLINIC_UTC_OFFSET_MIN = 180;

const MS_PER_MIN = 60_000;
const MIN_PER_DAY = 1440;
/** JDN of 1970-01-01. */
const UNIX_EPOCH_JDN = 2440588;

/** A clinic-local wall-clock moment: Gregorian date + minutes since local midnight (0–1439). */
export interface LocalDateTime {
  date: string;
  minutes: number;
}

/** UTC instant (epoch ms) → clinic-local date and minute of day. Seconds are truncated. */
export function utcToLocal(utcMs: number): LocalDateTime {
  const totalMin = Math.floor(utcMs / MS_PER_MIN) + CLINIC_UTC_OFFSET_MIN;
  const dayIndex = Math.floor(totalMin / MIN_PER_DAY);
  return {
    date: formatIsoDate(jdnToGregorian(UNIX_EPOCH_JDN + dayIndex)),
    minutes: totalMin - dayIndex * MIN_PER_DAY,
  };
}

/** Clinic-local date + minutes since midnight → UTC instant (epoch ms). `minutes` may exceed a day. */
export function localToUtc(date: string, minutes: number): number {
  const dayIndex = gregorianToJdn(parseIsoDate(date)) - UNIX_EPOCH_JDN;
  return (dayIndex * MIN_PER_DAY + minutes - CLINIC_UTC_OFFSET_MIN) * MS_PER_MIN;
}

/** Today's clinic-local date for a UTC instant. */
export function localDateOf(utcMs: number): string {
  return utcToLocal(utcMs).date;
}
