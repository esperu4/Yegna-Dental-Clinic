/** Weekly clinic hours as the Doctor edits them (PRD §6 defaults, §8 items 2 and 12). */
import type { SettingsRow } from '@yegna/shared/client';
import { DEFAULT_WEEKLY_HOURS, GRID_STEP_MIN, type WeekdayHours, type WeeklyDefaults } from '@yegna/time';
import type { MessageKey } from '../i18n/index.ts';

/** The weekly hours in force: the synced settings row, or the PRD defaults before it exists. */
export function weeklyHoursOf(
  settings: Pick<SettingsRow, 'weeklyHours' | 'deletedAt'> | undefined,
): WeeklyDefaults {
  // A row created locally by another settings change (e.g. the default template) before the
  // first full pull may not carry the hours yet.
  return (settings && settings.deletedAt == null && settings.weeklyHours) || DEFAULT_WEEKLY_HOURS;
}

/** Times offered in the editor: 05:00 (11:00 ET at night) to 22:00, on the 15-minute grid. */
export const TIME_CHOICES: readonly number[] = Array.from(
  { length: ((22 - 5) * 60) / GRID_STEP_MIN + 1 },
  (_, i) => 5 * 60 + i * GRID_STEP_MIN,
);

/** What is wrong with one weekday's hours, or null. Mirrors the server's settings checks. */
export function weekdayProblem(hours: WeekdayHours | null): MessageKey | null {
  if (!hours) return null;
  if (hours.openAt >= hours.closeAt) return 'hours.error.closeBeforeOpen';
  if ((hours.lunchStart === null) !== (hours.lunchEnd === null)) return 'hours.error.lunch';
  if (hours.lunchStart !== null && hours.lunchEnd !== null) {
    if (hours.lunchStart >= hours.lunchEnd) return 'hours.error.lunch';
    if (hours.lunchStart < hours.openAt || hours.lunchEnd > hours.closeAt) return 'hours.error.lunchOutside';
  }
  return null;
}

/** A weekday switched on gets the standard day as a starting point. */
export const STANDARD_DAY: WeekdayHours = {
  openAt: 9 * 60,
  closeAt: 18 * 60,
  lunchStart: 12 * 60,
  lunchEnd: 13 * 60,
};

export function withWeekday(
  week: WeeklyDefaults,
  weekday: number,
  hours: WeekdayHours | null,
): WeeklyDefaults {
  const next = [...week];
  next[weekday] = hours;
  return next as unknown as WeeklyDefaults;
}
