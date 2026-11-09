/**
 * Clinic-hours logic (PRD §6). All times of day are clinic-local minutes since midnight.
 * Close time, closed days and blocks are HARD limits; lunch is SOFT (warn, then allow).
 */
import { type Weekday, weekdayOf } from './gregorian.ts';
import { localToUtc } from './zone.ts';

export const GRID_STEP_MIN = 15;
export const DEFAULT_UNSPECIFIED_DURATION_MIN = 60;

/** Opening hours for one weekday; `null` means closed that weekday. */
export interface WeekdayHours {
  openAt: number;
  closeAt: number;
  lunchStart: number | null;
  lunchEnd: number | null;
}

/** Indexed by weekday, 0 = Sunday … 6 = Saturday. */
export type WeeklyDefaults = readonly [
  WeekdayHours | null,
  WeekdayHours | null,
  WeekdayHours | null,
  WeekdayHours | null,
  WeekdayHours | null,
  WeekdayHours | null,
  WeekdayHours | null,
];

const STANDARD_DAY: WeekdayHours = {
  openAt: 9 * 60,
  closeAt: 18 * 60,
  lunchStart: 12 * 60,
  lunchEnd: 13 * 60,
};

/**
 * PRD §6 defaults: Monday–Saturday, open 3:00 ET (09:00), close 12:00 ET (18:00),
 * lunch 6:00–7:00 ET (12:00–13:00); closed Sunday.
 * The default closing time is still to be confirmed (PRD §22 #2).
 */
export const DEFAULT_WEEKLY_HOURS: WeeklyDefaults = [
  null,
  STANDARD_DAY,
  STANDARD_DAY,
  STANDARD_DAY,
  STANDARD_DAY,
  STANDARD_DAY,
  STANDARD_DAY,
];

/** A `day_rules` row: the doctor's override for one date. Fields left null fall back to the weekly default. */
export interface DayRule {
  date: string;
  closed: boolean;
  openAt: number | null;
  closeAt: number | null;
  lunchStart: number | null;
  lunchEnd: number | null;
}

/** A `holidays` row. */
export interface Holiday {
  date: string;
  closed: boolean;
}

/** A `blocks` row, as UTC instants (epoch ms). */
export interface Block {
  startAt: number;
  endAt: number;
}

export type ClosedReason = 'weekly' | 'holiday' | 'day_rule';

export type ResolvedDay =
  { date: string; closed: true; reason: ClosedReason } | ({ date: string; closed: false } & WeekdayHours);

/**
 * Resolve the hours for one date. Precedence: the doctor's `day_rules` entry,
 * then a holiday, then the weekly default.
 */
export function resolveDay(
  date: string,
  weekly: WeeklyDefaults,
  dayRule?: DayRule | null,
  holiday?: Holiday | null,
): ResolvedDay {
  const base = weekly[weekdayOf(date) as Weekday];
  if (dayRule) {
    if (dayRule.closed) return { date, closed: true, reason: 'day_rule' };
    const fallback = base ?? STANDARD_DAY;
    return {
      date,
      closed: false,
      openAt: dayRule.openAt ?? fallback.openAt,
      closeAt: dayRule.closeAt ?? fallback.closeAt,
      lunchStart: dayRule.lunchStart ?? fallback.lunchStart,
      lunchEnd: dayRule.lunchEnd ?? fallback.lunchEnd,
    };
  }
  if (holiday?.closed) return { date, closed: true, reason: 'holiday' };
  if (!base) return { date, closed: true, reason: 'weekly' };
  return { date, closed: false, ...base };
}

export type BookingError =
  'invalid_duration' | 'off_grid' | 'closed_day' | 'holiday' | 'before_open' | 'after_close' | 'in_block';

export type BookingWarning = 'lunch';

export interface BookingCheck {
  /** Hard errors: the booking cannot be saved. */
  errors: BookingError[];
  /** Soft warnings: ask "Book anyway?", then allow. */
  warnings: BookingWarning[];
}

/**
 * Check a proposed booking against one resolved day.
 * `startMin` is local minutes since midnight on `day.date`; `blocks` may include
 * blocks from any date (only overlapping ones matter).
 */
export function checkBooking(
  day: ResolvedDay,
  startMin: number,
  durationMin: number,
  blocks: readonly Block[] = [],
): BookingCheck {
  const errors: BookingError[] = [];
  const warnings: BookingWarning[] = [];

  if (!Number.isInteger(durationMin) || durationMin <= 0 || durationMin % GRID_STEP_MIN !== 0) {
    errors.push('invalid_duration');
  }
  if (!Number.isInteger(startMin) || startMin % GRID_STEP_MIN !== 0) errors.push('off_grid');

  if (day.closed) {
    errors.push(day.reason === 'holiday' ? 'holiday' : 'closed_day');
    return { errors, warnings };
  }

  const endMin = startMin + durationMin;
  if (startMin < day.openAt) errors.push('before_open');
  if (endMin > day.closeAt) errors.push('after_close');

  const startUtc = localToUtc(day.date, startMin);
  const endUtc = localToUtc(day.date, endMin);
  if (blocks.some((b) => b.startAt < endUtc && startUtc < b.endAt)) errors.push('in_block');

  if (
    day.lunchStart !== null &&
    day.lunchEnd !== null &&
    startMin < day.lunchEnd &&
    day.lunchStart < endMin
  ) {
    warnings.push('lunch');
  }
  return { errors, warnings };
}

/** Start times (local minutes) on the 15-minute grid from open until close. Empty when closed. */
export function gridSlots(day: ResolvedDay): number[] {
  if (day.closed) return [];
  const slots: number[] = [];
  const first = Math.ceil(day.openAt / GRID_STEP_MIN) * GRID_STEP_MIN;
  for (let m = first; m < day.closeAt; m += GRID_STEP_MIN) slots.push(m);
  return slots;
}

/** Booking duration: the procedure's default, or the unspecified default (60 min). */
export function bookingDuration(
  procedureDurationMin: number | null | undefined,
  unspecifiedDefault: number = DEFAULT_UNSPECIFIED_DURATION_MIN,
): number {
  return procedureDurationMin ?? unspecifiedDefault;
}
