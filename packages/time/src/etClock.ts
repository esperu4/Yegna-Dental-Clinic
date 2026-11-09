/**
 * ET time: Ethiopian clock time. ET hour = local hour − 6, on a 12-hour cycle.
 * 09:00 → 3:00 ጠዋት, 12:00 → 6:00 ቀትር, 13:00 → 7:00 ከሰዓት, 18:00 → 12:00 ማታ.
 */

export type EtPeriod = 'night' | 'morning' | 'midday' | 'afternoon' | 'evening';

/**
 * The one mapping table for period labels (PRD §6).
 *
 * PROVISIONAL: the exact boundaries are open item PRD §22 #1 and must be confirmed
 * with the clinic before M1. They currently fit the PRD §6 examples only.
 * `from` is local minutes since midnight; each period runs until the next one starts.
 */
export const ET_PERIODS: readonly { period: EtPeriod; from: number; am: string; en: string }[] = [
  { period: 'night', from: 0, am: 'ሌሊት', en: 'night' },
  { period: 'morning', from: 6 * 60, am: 'ጠዋት', en: 'morning' },
  { period: 'midday', from: 12 * 60, am: 'ቀትር', en: 'midday' },
  { period: 'afternoon', from: 13 * 60, am: 'ከሰዓት', en: 'afternoon' },
  { period: 'evening', from: 18 * 60, am: 'ማታ', en: 'evening' },
];

export interface EtTime {
  /** 1–12 */
  hour: number;
  /** 0–59 */
  minute: number;
  period: EtPeriod;
}

function assertMinuteOfDay(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) {
    throw new RangeError(`Minutes since midnight out of range: ${minutes}`);
  }
}

export function periodOf(localMinutes: number): EtPeriod {
  assertMinuteOfDay(localMinutes);
  let current = ET_PERIODS[0]!;
  for (const p of ET_PERIODS) if (localMinutes >= p.from) current = p;
  return current.period;
}

export function periodLabel(period: EtPeriod, locale: 'am' | 'en'): string {
  return ET_PERIODS.find((p) => p.period === period)![locale];
}

/** Local minutes since midnight → ET time. */
export function toEtTime(localMinutes: number): EtTime {
  assertMinuteOfDay(localMinutes);
  const localHour = Math.floor(localMinutes / 60);
  const hour = (((localHour - 6) % 12) + 12) % 12 || 12;
  return { hour, minute: localMinutes % 60, period: periodOf(localMinutes) };
}

/** ET time → local minutes since midnight. Throws if the period does not contain that time. */
export function fromEtTime({ hour, minute, period }: EtTime): number {
  if (
    !Number.isInteger(hour) ||
    hour < 1 ||
    hour > 12 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    throw new RangeError(`Invalid ET time: ${hour}:${minute}`);
  }
  // Each ET hour maps to two local hours, 12 hours apart; the period picks one.
  const first = ((hour + 6) % 12) * 60 + minute;
  for (const candidate of [first, first + 720]) {
    if (periodOf(candidate) === period) return candidate;
  }
  throw new RangeError(`ET time ${hour}:${String(minute).padStart(2, '0')} is not in period ${period}`);
}

/** e.g. `3:00 ጠዋት` / `3:00 morning`. */
export function formatEtTime(localMinutes: number, locale: 'am' | 'en'): string {
  const t = toEtTime(localMinutes);
  return `${t.hour}:${String(t.minute).padStart(2, '0')} ${periodLabel(t.period, locale)}`;
}

/** Gregorian 24-hour display, e.g. `09:00`. */
export function formatLocalTime(localMinutes: number): string {
  assertMinuteOfDay(localMinutes);
  return `${String(Math.floor(localMinutes / 60)).padStart(2, '0')}:${String(localMinutes % 60).padStart(2, '0')}`;
}
