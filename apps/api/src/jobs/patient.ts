/**
 * Patient bot messages (PRD §14, §16): confirmations when the Doctor approves, reminders the day
 * before, and a notice when the clinic cancels a booking the patient was told about.
 *
 * The one rule that matters most (PRD §20 M5): **nothing is ever sent for a booking that is not
 * approved.** Confirmations and reminders read only `approved` bookings (`approvedBookings`); the
 * cancellation notice goes only for a booking whose confirmation this chat actually received.
 * Each message goes once per (booking, start time, chat) through `notification_log`.
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { bookings, notificationLog, patients, procedures, settings } from '@yegna/db';
import { SETTINGS_ID } from '@yegna/shared';
import { type LocalDateTime, addDays, localToUtc } from '@yegna/time';
import type { Db } from '../lib/db.ts';
import type { QueryMeter } from '../lib/queryMeter.ts';
import { deliverOnce } from '../notify/deliver.ts';
import type { Notifier } from '../notify/notifier.ts';
import {
  type PatientBooking,
  type PatientLocale,
  cancellationMessage,
  confirmationMessage,
  reminderMessage,
} from '../notify/patientMessages.ts';

export interface PatientJobContext {
  db: Db;
  meter: QueryMeter;
  /** The Yegna Dental bot. */
  notifier: Notifier;
  now: number;
  local: LocalDateTime;
}

const PER_DELIVERY = 3;
const hasBudget = (ctx: Pick<PatientJobContext, 'meter'>) => ctx.meter.remaining() >= PER_DELIVERY + 2;

/** How far back the hourly run looks for approvals and cancellations it may have missed. */
export const PATIENT_CATCH_UP_MS = 48 * 60 * 60_000;

/** The `notification_log` key of a message about a booking at one start time. */
export const atKey = (b: { id: string; startAt: number }) => `${b.id}|${b.startAt}`;

type Row = PatientBooking & { chatId: string; locale: PatientLocale };

/** Bookings of linked, live patients, with what a patient message shows. */
function patientBookingsWhere(db: Db, ...conditions: Parameters<typeof and>) {
  return db
    .select({
      id: bookings.id,
      startAt: bookings.startAt,
      chatId: patients.telegramChatId,
      locale: patients.telegramLocale,
      procedureNameAm: procedures.nameAm,
      procedureNameEn: procedures.nameEn,
    })
    .from(bookings)
    .innerJoin(patients, eq(patients.id, bookings.patientId))
    .leftJoin(procedures, eq(procedures.id, bookings.procedureId))
    .where(
      and(
        isNull(bookings.deletedAt),
        isNull(patients.deletedAt),
        isNotNull(patients.telegramChatId),
        ...conditions,
      ),
    )
    .orderBy(asc(bookings.startAt))
    .all()
    .then((rows) => rows.map((r): Row => ({ ...r, chatId: r.chatId!, locale: r.locale ?? 'am' })));
}

/** Approved, still ahead: the only bookings a confirmation or reminder may be about. */
export function approvedBookings(db: Db, now: number, ...conditions: Parameters<typeof and>) {
  return patientBookingsWhere(db, eq(bookings.status, 'approved'), gt(bookings.startAt, now), ...conditions);
}

/**
 * A confirmation for each booking approved recently (or each of `ids`, right after a sync), once
 * per start time: a booking moved and approved again is confirmed again with its new time.
 */
export async function patientConfirmations(ctx: PatientJobContext, ids?: string[]) {
  if (ids?.length === 0) return;
  const due = await approvedBookings(
    ctx.db,
    ctx.now,
    // updatedAt, not approvedAt: a Doctor's move keeps the booking approved with its old approvedAt.
    ids ? inArray(bookings.id, ids) : gt(bookings.updatedAt, ctx.now - PATIENT_CATCH_UP_MS),
  );
  for (const b of due) {
    if (!hasBudget(ctx)) return;
    await deliverOnce(
      ctx.db,
      ctx.notifier,
      { kind: 'patient_confirm', key: atKey(b), chatId: b.chatId },
      () => confirmationMessage(b.locale, b),
      ctx.now,
    );
  }
}

/** From the reminder time (18:00 by default) until midnight: tomorrow's approved bookings. */
export async function patientReminders(ctx: PatientJobContext) {
  const row = await ctx.db
    .select({ at: settings.patientReminderAt })
    .from(settings)
    .where(eq(settings.id, SETTINGS_ID))
    .get();
  if (ctx.local.minutes < (row?.at ?? 18 * 60)) return;
  const tomorrow = addDays(ctx.local.date, 1);
  const due = await approvedBookings(
    ctx.db,
    ctx.now,
    gte(bookings.startAt, localToUtc(tomorrow, 0)),
    lt(bookings.startAt, localToUtc(addDays(tomorrow, 1), 0)),
  );
  for (const b of due) {
    if (!hasBudget(ctx)) return;
    await deliverOnce(
      ctx.db,
      ctx.notifier,
      { kind: 'patient_reminder', key: atKey(b), chatId: b.chatId },
      () => reminderMessage(b.locale, b),
      ctx.now,
    );
  }
}

/**
 * A booking cancelled recently (or each of `ids`), still ahead, whose patient received a
 * confirmation **for its current time** in this chat: tell them once. A booking never confirmed
 * at that time was never announced, so its cancellation is not either (a time moved after the
 * confirmation and never approved again must not reach the patient; privacy review M5).
 */
export async function patientCancellations(ctx: PatientJobContext, ids?: string[]) {
  if (ids?.length === 0) return;
  const cancelled = await patientBookingsWhere(
    ctx.db,
    eq(bookings.status, 'cancelled'),
    gt(bookings.startAt, ctx.now),
    ids ? inArray(bookings.id, ids) : gt(bookings.updatedAt, ctx.now - PATIENT_CATCH_UP_MS),
  );
  for (const b of cancelled) {
    if (!hasBudget(ctx)) return;
    const told = await ctx.db
      .select({ id: notificationLog.id })
      .from(notificationLog)
      .where(
        and(
          eq(notificationLog.kind, 'patient_confirm'),
          eq(notificationLog.targetChatId, b.chatId),
          eq(notificationLog.status, 'sent'),
          eq(notificationLog.bookingId, atKey(b)),
        ),
      )
      .get();
    if (!told) continue;
    await deliverOnce(
      ctx.db,
      ctx.notifier,
      { kind: 'patient_cancel', key: b.id, chatId: b.chatId },
      () => cancellationMessage(b.locale, b),
      ctx.now,
    );
  }
}

/** The hourly patient jobs, most important first. */
export const PATIENT_JOBS = [
  ['patient_confirm', (ctx: PatientJobContext) => patientConfirmations(ctx)],
  ['patient_cancel', (ctx: PatientJobContext) => patientCancellations(ctx)],
  ['patient_reminder', patientReminders],
] as const;
