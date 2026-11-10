/**
 * The bookings a device keeps (PRD §7.1): today − 30 days onwards, in clinic time. The server
 * leaves older bookings out of a first fill, and the device drops bookings that have aged out
 * of the window; history loads on demand.
 */
import { addDays, localDateOf, localToUtc } from '@yegna/time';
import { WINDOW_PAST_DAYS } from './syncTypes.ts';

/** Start of the window: midnight (clinic time) of today − 30 days, as a UTC instant. */
export function bookingWindowStart(now: number): number {
  return localToUtc(addDays(localDateOf(now), -WINDOW_PAST_DAYS), 0);
}
