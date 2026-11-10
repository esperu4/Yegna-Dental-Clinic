/** Booking checks used by `/sync` (PRD §6 clinic hours, §7.4 clash check). */
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { blocks, dayRules, holidays, settings } from '@yegna/db';
import { CLASH_STATUSES, MAX_BOOKING_MIN, SETTINGS_ID } from '@yegna/shared';
import {
  type BookingError,
  DEFAULT_WEEKLY_HOURS,
  GRID_STEP_MIN,
  type DayRule,
  type WeeklyDefaults,
  checkBooking,
  localToUtc,
  resolveDay,
  utcToLocal,
} from '@yegna/time';
import { CURRENT_VERSION, type Db } from '../lib/db.ts';

const MS_PER_MIN = 60_000;

/** The reads behind a clinic-hours check, to run inside a larger read batch. */
export function hoursQueries(db: Db, startAt: number, durationMin: number) {
  const { date } = utcToLocal(startAt);
  const endAt = startAt + durationMin * MS_PER_MIN;
  return [
    db.select({ weeklyHours: settings.weeklyHours }).from(settings).where(eq(settings.id, SETTINGS_ID)),
    db
      .select()
      .from(dayRules)
      .where(and(eq(dayRules.date, date), isNull(dayRules.deletedAt))),
    db
      .select({ date: holidays.date, closed: holidays.closed })
      .from(holidays)
      .where(and(eq(holidays.date, date), eq(holidays.closed, true), isNull(holidays.deletedAt)))
      .limit(1),
    db
      .select({ startAt: blocks.startAt, endAt: blocks.endAt })
      .from(blocks)
      .where(and(lt(blocks.startAt, endAt), gt(blocks.endAt, startAt), isNull(blocks.deletedAt))),
  ] as const;
}

type HoursRows = [
  { weeklyHours: string }[],
  DayRule[],
  { date: string; closed: boolean }[],
  { startAt: number; endAt: number }[],
];

/**
 * The first hard clinic-hours error for a booking (closed day, holiday, before open,
 * after close, inside a block), or null, from the rows `hoursQueries` read.
 * Lunch is only a warning, so it is ignored here.
 */
export function hoursError(rows: unknown[], startAt: number, durationMin: number): BookingError | null {
  const [settingsRow, rule, holiday, overlapping] = rows as HoursRows;
  const { date, minutes } = utcToLocal(startAt);
  const day = resolveDay(date, parseWeekly(settingsRow[0]?.weeklyHours), rule[0] ?? null, holiday[0] ?? null);
  return checkBooking(day, minutes, durationMin, overlapping).errors[0] ?? null;
}

/** Whether the clinic is open on `date` (weekly hours, the Doctor's day rule, holidays). */
export async function isClinicOpen(db: Db, date: string): Promise<boolean> {
  const rows = (await db.batch(
    hoursQueries(db, localToUtc(date, 12 * 60), GRID_STEP_MIN) as never,
  )) as HoursRows;
  const [settingsRow, rule, holiday] = rows;
  return !resolveDay(date, parseWeekly(settingsRow[0]?.weeklyHours), rule[0] ?? null, holiday[0] ?? null)
    .closed;
}

/** `hoursQueries` + `hoursError` as one batch, for when nothing else needs reading. */
export async function clinicHoursError(
  db: Db,
  startAt: number,
  durationMin: number,
): Promise<BookingError | null> {
  const rows = await db.batch(hoursQueries(db, startAt, durationMin) as never);
  return hoursError(rows as unknown[], startAt, durationMin);
}

function parseWeekly(json: string | undefined): WeeklyDefaults {
  if (!json) return DEFAULT_WEEKLY_HOURS;
  try {
    return JSON.parse(json) as WeeklyDefaults;
  } catch {
    return DEFAULT_WEEKLY_HOURS;
  }
}

/**
 * The active booking that keeps the slot when `bookingId` overlaps it: the earliest-accepted
 * (lowest version) overlapping booking in `pending_approval`, `approved` or `arrived`.
 * Range-scans `bookings_status_start_idx`; the lower bound works because no booking is longer
 * than `MAX_BOOKING_MIN`.
 */
function winnerSql(bookingId: string, startAt: number, durationMin: number) {
  const endAt = startAt + durationMin * MS_PER_MIN;
  const statuses = sql.join(
    CLASH_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  return sql`(SELECT o.id FROM bookings o
    WHERE o.status IN (${statuses})
      AND o.start_at < ${endAt}
      AND o.start_at > ${startAt - MAX_BOOKING_MIN * MS_PER_MIN}
      AND o.start_at + o.duration_min * ${MS_PER_MIN} > ${startAt}
      AND o.id <> ${bookingId}
      AND o.deleted_at IS NULL
    ORDER BY o.version LIMIT 1)`;
}

/**
 * Turns the just-written booking into a clash if it overlaps an active one (PRD §7.4).
 * Only touches the row if this batch's write went through (it carries the new version).
 * Runs in the same batch as the write, as one statement: D1 applies batches one at a time,
 * so of two overlapping bookings sent at the same moment exactly one wins.
 */
export function clashStatement(bookingId: string, startAt: number, durationMin: number) {
  const winner = winnerSql(bookingId, startAt, durationMin);
  return sql`UPDATE bookings
    SET status = 'clash', clash_with_id = ${winner}, approved_by = NULL, approved_at = NULL
    WHERE id = ${bookingId} AND version = ${CURRENT_VERSION} AND ${winner} IS NOT NULL`;
}

/** The `sync_ops` result for a booking whose clash check ran in this batch. */
export function clashAwareResult(opId: string, bookingId: string) {
  return sql`(SELECT CASE WHEN b.status = 'clash'
      THEN json_object('opId', ${opId}, 'outcome', 'clash', 'version', b.version, 'winner', b.clash_with_id)
      ELSE json_object('opId', ${opId}, 'outcome', 'applied', 'version', b.version) END
    FROM bookings b WHERE b.id = ${bookingId})`;
}

/**
 * True if nothing a booking decision depended on has changed since the reads were taken at
 * `seenSeq` (the `sync_seq` value then): the patient and procedure are still live, and no day
 * rule, holiday, settings row or overlapping block for that time has a newer version. Part of the
 * booking write's guard, so a booking is never written against a deleted patient or into a block
 * that appeared after the check; the op is then decided again.
 */
export function bookingDependenciesUnchanged(input: {
  seenSeq: number;
  startAt: number;
  durationMin: number;
  patientId?: string | undefined;
  procedureId?: string | null | undefined;
}) {
  const { seenSeq, startAt, durationMin } = input;
  const { date } = utcToLocal(startAt);
  const endAt = startAt + durationMin * MS_PER_MIN;
  const checks = [
    sql`NOT EXISTS (SELECT 1 FROM settings WHERE version > ${seenSeq})`,
    sql`NOT EXISTS (SELECT 1 FROM day_rules WHERE date = ${date} AND version > ${seenSeq})`,
    sql`NOT EXISTS (SELECT 1 FROM holidays WHERE date = ${date} AND version > ${seenSeq})`,
    sql`NOT EXISTS (SELECT 1 FROM blocks
          WHERE start_at < ${endAt} AND end_at > ${startAt} AND version > ${seenSeq})`,
  ];
  if (input.patientId) {
    checks.push(sql`EXISTS (SELECT 1 FROM patients WHERE id = ${input.patientId} AND deleted_at IS NULL)`);
  }
  if (input.procedureId) {
    checks.push(
      sql`EXISTS (SELECT 1 FROM procedures WHERE id = ${input.procedureId} AND deleted_at IS NULL)`,
    );
  }
  return sql`(${sql.join(checks, sql` AND `)})`;
}
