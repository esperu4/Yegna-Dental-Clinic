/**
 * Ethiopian phone normalisation (PRD §5). Accepts 09…, 07…, +2519…, 2519… (and +2517…),
 * landlines such as 011…, with spaces and dashes. Output is E.164 (+251 + 9 digits).
 * An invalid phone is an inline error; never save it silently.
 */
export type PhoneResult = { ok: true; e164: string } | { ok: false; error: 'empty' | 'invalid' };

/** National significant number: 9 digits; mobiles start 9 (Ethio Telecom) or 7 (Safaricom), landlines 1–5. */
const NSN = /^[1-579]\d{8}$/;

export function normalizePhone(input: string): PhoneResult {
  const compact = input.replace(/[\s-]/g, '');
  if (compact === '') return { ok: false, error: 'empty' };

  let nsn: string | null = null;
  if (/^\+251\d+$/.test(compact)) nsn = compact.slice(4);
  else if (/^251\d+$/.test(compact)) nsn = compact.slice(3);
  else if (/^0\d+$/.test(compact)) nsn = compact.slice(1);

  if (nsn === null || !NSN.test(nsn)) return { ok: false, error: 'invalid' };
  return { ok: true, e164: `+251${nsn}` };
}

export function isMobileE164(e164: string): boolean {
  return /^\+251[79]\d{8}$/.test(e164);
}
