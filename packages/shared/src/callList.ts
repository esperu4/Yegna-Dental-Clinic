/**
 * Call list and approvals (PRD §8 items 7–8, §10, ADR 0008). Pure, and shared: the PWA computes
 * the lists from its working copy (offline), and the server's 18:00 team message uses the same rule.
 */
import type { BookingRow, PatientRequestRow, PatientRow } from './syncTypes.ts';
import { addDays, localDateOf, localToUtc, utcToLocal } from '@yegna/time';

export const UNAPPROVED_ALERT_MS = 24 * 60 * 60_000;

/**
 * Why a booking is on the call list: its patient has no Telegram, it is unapproved too close, or
 * the patient asked from the patient bot to reschedule or cancel (PRD §14).
 */
export type CallReason = 'noTelegram' | 'unapproved' | 'rescheduleRequest' | 'cancelRequest';

export interface CallItem {
  booking: BookingRow;
  patient: PatientRow;
  reasons: CallReason[];
  /** The open patient requests on this booking (each is marked handled on its own). */
  requests: PatientRequestRow[];
}

/** The bookings a call list needs: from now until the end of tomorrow (clinic time). */
export function callListRange(now: number): [number, number] {
  return [now, localToUtc(addDays(localDateOf(now), 2), 0)];
}

/**
 * Who the front desk must phone (PRD §8 item 8): tomorrow's patients without Telegram, and
 * bookings still waiting for approval less than 24 h before their start (§10). A booking already
 * handled leaves the list (ADR 0008); moving it brings it back. Open patient requests join the
 * list whatever the booking's date or status, until marked handled (`bookings` must hold their
 * bookings too). Soonest first.
 */
export function callList(
  bookings: readonly BookingRow[],
  patients: ReadonlyMap<string, PatientRow>,
  now: number,
  requests: readonly PatientRequestRow[] = [],
): CallItem[] {
  const tomorrow = addDays(localDateOf(now), 1);
  const openRequests = new Map<string, PatientRequestRow[]>();
  for (const r of requests) {
    if (r.deletedAt !== null || r.status !== 'open') continue;
    openRequests.set(r.bookingId, [...(openRequests.get(r.bookingId) ?? []), r]);
  }
  const items: CallItem[] = [];
  const seen = new Set<string>();
  for (const booking of bookings) {
    if (seen.has(booking.id)) continue;
    seen.add(booking.id);
    if (booking.deletedAt !== null) continue;
    const patient = patients.get(booking.patientId);
    // An erased patient can't be called (ADR 0007).
    if (!patient || patient.deletedAt !== null) continue;
    const reasons: CallReason[] = [];
    const upcoming =
      booking.startAt > now && (booking.status === 'pending_approval' || booking.status === 'approved');
    const handled = booking.callHandledAt;
    if (
      upcoming &&
      handled === null &&
      utcToLocal(booking.startAt).date === tomorrow &&
      !patient.telegramLinked
    ) {
      reasons.push('noTelegram');
    }
    // Still unapproved 24 h before: back on the list even if a call was handled earlier (PRD §10).
    const alertFrom = booking.startAt - UNAPPROVED_ALERT_MS;
    if (
      upcoming &&
      booking.status === 'pending_approval' &&
      now >= alertFrom &&
      (handled === null || handled < alertFrom)
    ) {
      reasons.push('unapproved');
    }
    // An open request stays listed until marked handled, even once its booking has passed, was
    // cancelled or moved: otherwise nobody could close it.
    const asked = openRequests.get(booking.id) ?? [];
    if (asked.some((r) => r.kind === 'reschedule')) reasons.push('rescheduleRequest');
    if (asked.some((r) => r.kind === 'cancel')) reasons.push('cancelRequest');
    if (reasons.length) items.push({ booking, patient, reasons, requests: asked });
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
