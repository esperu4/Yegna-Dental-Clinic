/**
 * Live working-copy reads for the schedule screens. Every query goes through an index
 * (bookings by start time, day rules by date, holidays by date), so screens stay fast with a
 * full working copy (PRD §8 performance targets).
 */
import type { PatientRow, ProcedureRow } from '@yegna/shared/client';
import { addDays } from '@yegna/time';
import { db } from './db.ts';
import { live, useLive } from './live.ts';
import { type DayPlan, dayRange, planDay } from './schedule.ts';
import { weeklyHoursOf } from './weeklyHours.ts';

/** Plans for `days` consecutive dates from `firstDate`. */
async function loadPlans(firstDate: string, days: number): Promise<DayPlan[]> {
  const dates = Array.from({ length: days }, (_, i) => addDays(firstDate, i));
  const from = dayRange(dates[0]!).start;
  const to = dayRange(dates.at(-1)!).end;
  const [settings, dayRules, holidays, blocks, bookings] = await Promise.all([
    db.settings.get('settings'),
    db.dayRules.where('date').anyOf(dates).toArray(),
    db.holidays.where('date').anyOf(dates).toArray(),
    // Blocks can be long (a week away), so read those starting before the range ends.
    db.blocks.where('startAt').below(to).toArray(),
    db.bookings.where('startAt').between(from, to, true, false).toArray(),
  ]);
  const weekly = weeklyHoursOf(settings);
  return dates.map((date) =>
    planDay({
      date,
      weekly,
      dayRule: dayRules.find((r) => r.date === date),
      holidays,
      blocks,
      bookings,
    }),
  );
}

export function useDayPlan(date: string): DayPlan | undefined {
  return useLive(async () => (await loadPlans(date, 1))[0], [date]);
}

export function useWeekPlans(firstDate: string, days: number): DayPlan[] | undefined {
  return useLive(() => loadPlans(firstDate, days), [firstDate, days]);
}

/** Names and phones for the patients on screen, by id. */
export function usePatients(ids: readonly string[]): Map<string, PatientRow> | undefined {
  const key = [...new Set(ids)].sort().join(',');
  return useLive(async () => {
    const rows = await db.patients.bulkGet(key ? key.split(',') : []);
    return new Map(live(rows.filter((r) => r !== undefined)).map((p) => [p.id, p]));
  }, [key]);
}

/** All live procedures, by id (a short list). */
export function useProcedures(): Map<string, ProcedureRow> | undefined {
  return useLive(async () => new Map(live(await db.procedures.toArray()).map((p) => [p.id, p])), []);
}

/** All live patients, for the booking sheet's search (searched in memory on the device). */
export function useAllPatients(): PatientRow[] | undefined {
  return useLive(async () => live(await db.patients.toArray()), []);
}
