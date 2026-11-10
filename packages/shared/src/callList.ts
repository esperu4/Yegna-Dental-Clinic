/**
 * Call list and approvals (PRD §8 items 7–8, §10, ADR 0008). Pure, and shared: the PWA computes
 * the lists from its working copy (offline), and the server's 18:00 team message uses the same rule.
 */
import type { BookingRow, PatientRow } from './syncTypes.ts';
import { addDays, localDateOf, localToUtc, utcToLocal } from '@yegna/time';

export const UNAPPROVED_ALERT_MS = 24 * 60 * 60_000;

/** Why a booking is on the call list: its patient has no Telegram, or it is unapproved too close. */
export type CallReason = 'noTelegram' | 'unapproved';

export interface CallItem {
  booking: BookingRow;
  patient: PatientRow;
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
    if (booking.deletedAt !== null || booking.startAt <= now) continue;
    if (booking.status !== 'pending_approval' && booking.status !== 'approved') continue;
    const patient = patients.get(booking.patientId);
    // An erased patient can't be called (ADR 0007).
    if (!patient || patient.deletedAt !== null) continue;
    const handled = booking.callHandledAt;
    const reasons: CallReason[] = [];
    if (handled === null && utcToLocal(booking.startAt).date === tomorrow && !patient.telegramLinked) {
      reasons.push('noTelegram');
    }
    // Still unapproved 24 h before: back on the list even if a call was handled earlier (PRD §10).
    const alertFrom = booking.startAt - UNAPPROVED_ALERT_MS;
    if (
      booking.status === 'pending_approval' &&
      now >= alertFrom &&
      (handled === null || handled < alertFrom)
    ) {
      reasons.push('unapproved');
    }
    if (reasons.length) items.push({ booking, patient, reasons });
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
