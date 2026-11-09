/** Account rules shared by the API and the PWA. No dependencies, so the PWA bundle stays small. */

export const PIN_PATTERN = /^\d{4,6}$/;

/**
 * The Doctor's PIN must be 6 digits: the Doctor's name is public and the account has full rights,
 * so a 4-digit PIN could be guessed within the lockout limits in weeks (docs/adr/0005).
 */
export const DOCTOR_PIN_LENGTH = 6;

/**
 * PINs anyone would try first: one repeated digit, or a straight run up or down
 * (1234, 98765, 7890…). Refused when a PIN is chosen; still accepted at sign-in.
 */
export function isTrivialPin(pin: string): boolean {
  const d = [...pin].map(Number);
  const steps = new Set(d.slice(1).map((x, i) => (x - d[i]! + 10) % 10));
  return steps.size === 1 && [0, 1, 9].includes([...steps][0]!);
}

/** Names are matched trimmed, case-insensitive, with runs of spaces collapsed (Ge'ez has no case). */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}
