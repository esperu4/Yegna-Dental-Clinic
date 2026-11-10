/**
 * Team bot jobs run by the hourly dispatcher (PRD §13, §16). Each job decides from the current
 * data what is due, and sends through `deliverOnce`, so a job run twice (or an hour late) sends
 * nothing twice. Jobs stop early when the run's D1 query budget runs low; the next hour continues.
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { bookings, patients, procedures, settings, users } from '@yegna/db';
import {
  type BookingRow,
  type PatientRow,
  SETTINGS_ID,
  UNAPPROVED_ALERT_MS,
  callList,
  callListRange,
} from '@yegna/shared';
import { type LocalDateTime, addDays, localToUtc, parseIsoDate, toEthiopian } from '@yegna/time';
import type { Db } from '../lib/db.ts';
import type { QueryMeter } from '../lib/queryMeter.ts';
import { deliverOnce, markSent, sentKeys } from '../notify/deliver.ts';
import {
  type BookingLine,
  type Recipient,
  MAX_LINES,
  approvalDigest,
  callListMessage,
  clashAlert,
  movableHolidayReminder,
  tomorrowSummary,
  unapprovedAlert,
} from '../notify/messages.ts';
import type { Notifier } from '../notify/notifier.ts';
import { isClinicOpen } from '../sync/bookings.ts';

export interface JobContext {
  db: Db;
  meter: QueryMeter;
  notifier: Notifier;
  now: number;
  /** Clinic local date and time of `now`. */
  local: LocalDateTime;
  /** The PWA's address, for "Open" buttons. */
  pwaUrl: string;
}

/** Queries one delivery may use (claim, send result, and a little slack). */
const PER_DELIVERY = 3;
const hasBudget = (ctx: JobContext, deliveries = 1) => ctx.meter.remaining() >= deliveries * PER_DELIVERY + 2;

/** Team members who linked Telegram (PRD §13: unlinked users get nothing). */
export async function linkedTeam(db: Db): Promise<Recipient[]> {
  const rows = await db
    .select({
      userId: users.id,
      chatId: users.telegramChatId,
      role: users.role,
      locale: users.locale,
      calendar: users.calendar,
    })
    .from(users)
    .where(and(isNotNull(users.telegramChatId), isNull(users.disabledAt), isNull(users.deletedAt)))
    .all();
  return rows.map((r) => ({ ...r, chatId: r.chatId! }));
}

type BookingWithPatient = Awaited<ReturnType<typeof bookingsWhere>>[number];

/** Bookings with their patient's name and Telegram status and the procedure code, by start time. */
function bookingsWhere(db: Db, ...conditions: Parameters<typeof and>) {
  return db
    .select({
      id: bookings.id,
      version: bookings.version,
      patientId: bookings.patientId,
      startAt: bookings.startAt,
      durationMin: bookings.durationMin,
      status: bookings.status,
      createdBy: bookings.createdBy,
      callHandledAt: bookings.callHandledAt,
      patientName: patients.name,
      patientDeletedAt: patients.deletedAt,
      patientChatId: patients.telegramChatId,
      procedureCode: procedures.code,
    })
    .from(bookings)
    .innerJoin(patients, eq(patients.id, bookings.patientId))
    .leftJoin(procedures, eq(procedures.id, bookings.procedureId))
    .where(and(isNull(bookings.deletedAt), ...conditions))
    .orderBy(asc(bookings.startAt))
    .all();
}

const lineOf = (b: BookingWithPatient): BookingLine => ({
  id: b.id,
  version: b.version,
  // An erased patient has no name left (ADR 0007).
  patientName: b.patientDeletedAt === null ? b.patientName : '…',
  startAt: b.startAt,
  procedureCode: b.procedureCode,
});

/** How long after a clash its alert is still sent (the hourly run catches up within this). */
export const CLASH_ALERT_WINDOW_MS = 24 * 60 * 60_000;

/**
 * A booking that lost a clash: alert its creator and the Doctor(s) once (PRD §13 "on sync").
 * `/sync` calls this right after the clash with those bookings' ids; the hourly run catches up
 * with any clash of the last 24 h not yet sent (`ids` omitted).
 */
export async function clashAlerts(
  ctx: Pick<JobContext, 'db' | 'meter' | 'notifier' | 'now' | 'pwaUrl'>,
  team: Recipient[],
  ids?: string[],
) {
  if (team.length === 0) return;
  const clashed = await bookingsWhere(
    ctx.db,
    eq(bookings.status, 'clash'),
    gt(bookings.startAt, ctx.now),
    isNull(patients.deletedAt),
    ids ? inArray(bookings.id, ids) : gt(bookings.updatedAt, ctx.now - CLASH_ALERT_WINDOW_MS),
  );
  for (const booking of clashed) {
    const recipients = team.filter((r) => r.role === 'doctor' || r.userId === booking.createdBy);
    for (const r of recipients) {
      if (ctx.meter.remaining() < PER_DELIVERY + 2) return;
      await deliverOnce(
        ctx.db,
        ctx.notifier,
        { kind: 'clash', key: booking.id, chatId: r.chatId },
        () => clashAlert(r, lineOf(booking), ctx.pwaUrl),
        ctx.now,
      );
    }
  }
}

/** Hourly: bookings still waiting for approval less than 24 h before their start, once each (§10). */
export async function unapprovedAlerts(ctx: JobContext, team: Recipient[]) {
  if (team.length === 0) return;
  // Bookings of an erased patient can't be acted on (ADR 0007): no alert, no Approve button.
  const due = await bookingsWhere(
    ctx.db,
    eq(bookings.status, 'pending_approval'),
    gt(bookings.startAt, ctx.now),
    lt(bookings.startAt, ctx.now + UNAPPROVED_ALERT_MS + 1),
    isNull(patients.deletedAt),
  );
  for (const booking of due) {
    for (const r of team) {
      if (!hasBudget(ctx)) return;
      await deliverOnce(
        ctx.db,
        ctx.notifier,
        { kind: 'unapproved_24h', key: booking.id, chatId: r.chatId },
        () => unapprovedAlert(r, lineOf(booking)),
        ctx.now,
      );
    }
  }
}

/**
 * Hourly 07:00–21:00: to the Doctor, when bookings are waiting that no digest has shown yet.
 * Unshown bookings are listed first, at most `MAX_LINES`; each shown booking is recorded with the
 * digest's key and its version, so "Approve listed" approves exactly those, if unchanged.
 */
export async function approvalDigests(ctx: JobContext, team: Recipient[]) {
  const hour = Math.floor(ctx.local.minutes / 60);
  const doctors = team.filter((r) => r.role === 'doctor');
  if (hour < 7 || hour > 21 || doctors.length === 0) return;
  const pending = await bookingsWhere(
    ctx.db,
    eq(bookings.status, 'pending_approval'),
    gt(bookings.startAt, ctx.now),
    isNull(patients.deletedAt),
  );
  if (pending.length === 0) return;
  const digestKey = `${ctx.local.date}T${String(hour).padStart(2, '0')}`;
  for (const r of doctors) {
    if (!hasBudget(ctx, 3)) return;
    const seen = await sentKeys(
      ctx.db,
      'digest_seen',
      r.chatId,
      pending.map((b) => b.id),
    );
    const fresh = pending.filter((b) => !seen.has(b.id));
    if (fresh.length === 0) continue;
    const ordered = [...fresh, ...pending.filter((b) => seen.has(b.id))];
    const shown = ordered.slice(0, MAX_LINES);
    const result = await deliverOnce(
      ctx.db,
      ctx.notifier,
      { kind: 'approval_digest', key: `hour:${digestKey}`, chatId: r.chatId },
      () => approvalDigest(r, ordered.map(lineOf), digestKey),
      ctx.now,
    );
    if (result !== 'sent') continue;
    await markSent(
      ctx.db,
      'digest_seen',
      r.chatId,
      shown.map((b) => b.id),
      ctx.now,
    );
    await markSent(
      ctx.db,
      'digest_item',
      r.chatId,
      shown.map((b) => digestItemKey(digestKey, b)),
      ctx.now,
    );
  }
}

/** A booking listed in a digest: `<digest>|<booking id>|<version shown>`. */
export const digestItemKey = (digestKey: string, b: { id: string; version: number }) =>
  `${digestKey}|${b.id}|${b.version}`;

/** From the Doctor's summary time (19:00 by default) until midnight: tomorrow's schedule, if open. */
export async function tomorrowSummaries(ctx: JobContext, team: Recipient[]) {
  const doctors = team.filter((r) => r.role === 'doctor');
  if (doctors.length === 0) return;
  const row = await ctx.db
    .select({ at: settings.doctorSummaryAt })
    .from(settings)
    .where(eq(settings.id, SETTINGS_ID))
    .get();
  if (ctx.local.minutes < (row?.at ?? 19 * 60)) return;
  const tomorrow = addDays(ctx.local.date, 1);
  if (!(await isClinicOpen(ctx.db, tomorrow))) return;
  const rows = await bookingsWhere(
    ctx.db,
    gte(bookings.startAt, localToUtc(tomorrow, 0)),
    lt(bookings.startAt, localToUtc(addDays(tomorrow, 1), 0)),
  );
  const list = rows.filter((b) => b.status === 'pending_approval' || b.status === 'approved').map(lineOf);
  for (const r of doctors) {
    if (!hasBudget(ctx)) return;
    await deliverOnce(
      ctx.db,
      ctx.notifier,
      { kind: 'tomorrow_summary', key: `day:${tomorrow}`, chatId: r.chatId },
      () => tomorrowSummary(r, tomorrow, list, ctx.pwaUrl),
      ctx.now,
    );
  }
}

/** From 18:00 until midnight: the call list to the team, if anyone is on it (PRD §16). */
export async function callListMessages(ctx: JobContext, team: Recipient[]) {
  if (team.length === 0 || ctx.local.minutes < 18 * 60) return;
  const [from, to] = callListRange(ctx.now);
  const rows = await bookingsWhere(ctx.db, gte(bookings.startAt, from), lt(bookings.startAt, to));
  const byId = new Map(rows.map((b) => [b.id, b]));
  const items = callList(
    rows.map((b) => asBookingRow(b)),
    new Map(rows.map((b) => [b.patientId, asPatientRow(b)])),
    ctx.now,
  );
  if (items.length === 0) return;
  const lines = items.map((i) => ({
    booking: lineOf(byId.get(i.booking.id)!),
    noTelegram: i.reasons.includes('noTelegram'),
    unapproved: i.reasons.includes('unapproved'),
  }));
  for (const r of team) {
    if (!hasBudget(ctx)) return;
    await deliverOnce(
      ctx.db,
      ctx.notifier,
      { kind: 'call_list', key: `day:${ctx.local.date}`, chatId: r.chatId },
      () => callListMessage(r, lines, ctx.pwaUrl),
      ctx.now,
    );
  }
}

/** From 15 Meskerem, 09:00: once a year, ask the Doctor to enter the movable holidays (PRD §6, §16). */
export async function movableHolidayReminders(ctx: JobContext, team: Recipient[]) {
  const ec = toEthiopian(parseIsoDate(ctx.local.date));
  if (ec.month !== 1 || ec.day < 15 || ctx.local.minutes < 9 * 60) return;
  for (const r of team.filter((m) => m.role === 'doctor')) {
    if (!hasBudget(ctx)) return;
    await deliverOnce(
      ctx.db,
      ctx.notifier,
      { kind: 'holiday_reminder', key: `ec:${ec.year}`, chatId: r.chatId },
      () => movableHolidayReminder(r, ctx.pwaUrl),
      ctx.now,
    );
  }
}

/** The fields the shared call-list rule reads, from a joined row. */
function asBookingRow(b: BookingWithPatient): BookingRow {
  return { ...b, deletedAt: null } as unknown as BookingRow;
}

function asPatientRow(b: BookingWithPatient): PatientRow {
  return {
    id: b.patientId,
    name: b.patientName,
    telegramLinked: b.patientChatId !== null,
    deletedAt: b.patientDeletedAt,
  } as PatientRow;
}

/** Upcoming bookings of a day (not cancelled or no-show) as message lines, for /today and /tomorrow. */
export async function bookingLinesBetween(db: Db, from: number, to: number): Promise<BookingLine[]> {
  const rows = await bookingsWhere(db, gte(bookings.startAt, from), lt(bookings.startAt, to));
  return rows.filter((b) => b.status !== 'cancelled' && b.status !== 'no_show').map(lineOf);
}
