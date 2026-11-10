/**
 * Patient search for the booking sheet (PRD §8 item 5): by phone after 4 digits, or by name in
 * Ge'ez or Latin script. Searches the working copy, so it works offline.
 */
import { type PatientRow, normalizeName } from '@yegna/shared/client';

/** Digits typed before suggestions start (PRD §8 item 5). */
export const MIN_PHONE_DIGITS = 4;
export const MAX_SUGGESTIONS = 5;

/**
 * The national number the user is typing, without the country code or trunk 0:
 * "0911 23" → "91123", "+251 91" → "91".
 */
export function phoneDigits(typed: string): string {
  const digits = typed.replace(/\D/g, '');
  if (digits.startsWith('251')) return digits.slice(3);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/**
 * Patients whose phone contains the typed digits, best match first. Starts once 4 digits are
 * typed (counting a leading 0, as the user sees it) and at least 3 of the national number.
 */
export function searchByPhone(patients: readonly PatientRow[], typed: string): PatientRow[] {
  const digits = phoneDigits(typed);
  if (typed.replace(/\D/g, '').length < MIN_PHONE_DIGITS || digits.length < 3) return [];
  return patients
    .filter((p) => p.deletedAt == null && p.phoneE164.slice(4).includes(digits))
    .sort(
      (a, b) =>
        Number(!a.phoneE164.slice(4).startsWith(digits)) - Number(!b.phoneE164.slice(4).startsWith(digits)) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, MAX_SUGGESTIONS);
}

/** Patients whose name contains the typed text (any word; case and extra spaces ignored). */
export function searchByName(patients: readonly PatientRow[], typed: string): PatientRow[] {
  const query = normalizeName(typed);
  if (query.length < 2) return [];
  return patients
    .filter((p) => p.deletedAt == null && normalizeName(p.name).includes(query))
    .sort(
      (a, b) =>
        Number(!normalizeName(a.name).startsWith(query)) - Number(!normalizeName(b.name).startsWith(query)) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, MAX_SUGGESTIONS);
}
