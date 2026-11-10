/**
 * Call list and approvals (PRD §8 items 7–8, §10). Pure: the screens pass in rows from the
 * working copy, so both lists work offline and are unit-tested.
 */
import type { BookingRow, PatientRow } from '@yegna/shared/client';
import { addDays, localDateOf, localToUtc, utcToLocal } from '@yegna/time';

export const UNAPPROVED_ALERT_MS = 24 * 60 * 60_000;

/** Why a booking is on the call list: its patient has no Telegram, or it is unapproved too close. */
export type CallReason = 'noTelegram' | 'unapproved';

export interface CallItem {
  booking: BookingRow;
  patient: PatientRow | undefined;
  reasons: CallReason[];
}

/** The bookings a call list needs: from now until the end of tomorrow (clinic time). */
export function callListRange(now: number): [number, number] {
  return [now, localToUtc(addDays(localDateOf(now), 2), 0)];
}

/**
 * Who the front desk must phone (PRD §8 item 8): tomorrow's patients without Telegram, and
 * bookings still waiting for approval less than 24 h before their start (§10). A booking already
 * handled leaves the list (ADR 0008); moving it brings it back. Open patient requests join the
 * list with the patient bot (M5). Soonest first.
 */
export function callList(
  bookings: readonly BookingRow[],
  patients: ReadonlyMap<string, PatientRow>,
  now: number,
): CallItem[] {
  const tomorrow = addDays(localDateOf(now), 1);
  const items: CallItem[] = [];
  for (const booking of bookings) {
    if (booking.deletedAt !== null || booking.callHandledAt !== null || booking.startAt <= now) continue;
    if (booking.status !== 'pending_approval' && booking.status !== 'approved') continue;
    const patient = patients.get(booking.patientId);
    const live = patient?.deletedAt == null ? patient : undefined;
    const reasons: CallReason[] = [];
    if (utcToLocal(booking.startAt).date === tomorrow && !live?.telegramLinked) reasons.push('noTelegram');
    if (booking.status === 'pending_approval' && booking.startAt - now <= UNAPPROVED_ALERT_MS) {
      reasons.push('unapproved');
    }
    if (reasons.length) items.push({ booking, patient: live, reasons });
  }
  return items.sort((a, b) => a.booking.startAt - b.booking.startAt);
}

/** Bookings waiting for the Doctor's approval from now on, grouped by clinic day (PRD §8 item 7). */
export function approvalsByDay(
  bookings: readonly BookingRow[],
  now: number,
): { date: string; bookings: BookingRow[] }[] {
  const days = new Map<string, BookingRow[]>();
  const pending = bookings
    .filter((b) => b.deletedAt === null && b.status === 'pending_approval' && b.startAt > now)
    .sort((a, b) => a.startAt - b.startAt);
  for (const booking of pending) {
    const { date } = utcToLocal(booking.startAt);
    days.set(date, [...(days.get(date) ?? []), booking]);
  }
  return [...days].map(([date, list]) => ({ date, bookings: list }));
}
