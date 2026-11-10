/**
 * Live working-copy reads for the schedule screens. Every query goes through an index
 * (bookings by start time, day rules by date, holidays by date), so screens stay fast with a
 * full working copy (PRD §8 performance targets).
 */
import Dexie from 'dexie';
import { useEffect, useState } from 'preact/hooks';
import {
  type CallItem,
  type PatientRow,
  type ProcedureRow,
  approvalsByDay,
  callList,
  callListRange,
} from '@yegna/shared/client';
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

/** The current minute, ticking: lists that depend on the time of day re-read when it changes. */
function useMinute(): number {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const timer = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 15_000);
    return () => clearInterval(timer);
  }, []);
  return minute;
}

/** The call list, kept current as the working copy changes and as time passes. */
export function useCallList(): CallItem[] | undefined {
  const minute = useMinute();
  return useLive(async () => {
    const now = Date.now();
    const [from, to] = callListRange(now);
    const bookings = await db.bookings.where('startAt').between(from, to).toArray();
    const patients = await db.patients.bulkGet([...new Set(bookings.map((b) => b.patientId))]);
    return callList(bookings, new Map(patients.flatMap((p) => (p ? [[p.id, p]] : []))), now);
  }, [minute]);
}

/**
 * Days with bookings waiting for approval (Doctor only: `enabled` false reads nothing), kept
 * current as the working copy changes and as time passes. Reads pending bookings by index.
 */
export function useApprovals(enabled = true) {
  const minute = useMinute();
  return useLive(async () => {
    if (!enabled) return { days: [], patients: new Map<string, PatientRow>() };
    const now = Date.now();
    const pending = await db.bookings
      .where('[status+startAt]')
      .between(['pending_approval', now], ['pending_approval', Dexie.maxKey])
      .toArray();
    const days = approvalsByDay(pending, now);
    const ids = [...new Set(days.flatMap((d) => d.bookings.map((b) => b.patientId)))];
    const patients = new Map((await db.patients.bulkGet(ids)).flatMap((p) => (p ? [[p.id, p]] : [])));
    return { days, patients };
  }, [minute, enabled]);
}
