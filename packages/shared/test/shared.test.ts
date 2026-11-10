import { describe, expect, it } from 'vitest';
import { bookingWindowStart, isMobileE164, isUuidv7, normalizePhone, uuidv7 } from '../src/index.ts';

describe('normalizePhone', () => {
  it.each([
    ['0911 23 45 67', '+251911234567'],
    ['0711-234-567', '+251711234567'],
    ['+251 911 234 567', '+251911234567'],
    ['251911234567', '+251911234567'],
    ['+251711234567', '+251711234567'],
    ['011 123 4567', '+251111234567'],
  ])('%s → %s', (input, e164) => {
    expect(normalizePhone(input)).toEqual({ ok: true, e164 });
  });

  it.each(['091123456', '09112345678', '0811234567', '+1 911 234 567', '911234567', 'abc', '0911a34567'])(
    'rejects %s',
    (input) => {
      expect(normalizePhone(input)).toEqual({ ok: false, error: 'invalid' });
    },
  );

  it('reports empty input separately', () => {
    expect(normalizePhone('  - ')).toEqual({ ok: false, error: 'empty' });
  });

  it('tells mobiles from landlines', () => {
    expect(isMobileE164('+251911234567')).toBe(true);
    expect(isMobileE164('+251711234567')).toBe(true);
    expect(isMobileE164('+251111234567')).toBe(false);
  });
});

describe('uuidv7', () => {
  it('is a valid v7 UUID carrying the timestamp, and sorts by time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(isUuidv7(a)).toBe(true);
    expect(parseInt(a.replace(/-/g, '').slice(0, 12), 16)).toBe(1_700_000_000_000);
    expect(a < b).toBe(true);
    expect(isUuidv7(uuidv7())).toBe(true);
    expect(isUuidv7('not-a-uuid')).toBe(false);
  });

  it('does not collide', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7(0)));
    expect(ids.size).toBe(10_000);
  });
});

describe('bookingWindowStart (PRD §7.1)', () => {
  it('is midnight in Addis Ababa, 30 days before today', () => {
    // 10:00 in Addis on 10 Nov 2026 → 00:00 in Addis on 11 Oct 2026 (21:00 UTC the day before).
    expect(bookingWindowStart(Date.UTC(2026, 10, 10, 7))).toBe(Date.UTC(2026, 9, 10, 21));
  });

  it('follows the clinic day, not the UTC day', () => {
    // 22:30 UTC on 10 Nov is already 11 Nov in Addis.
    expect(bookingWindowStart(Date.UTC(2026, 10, 10, 22, 30))).toBe(Date.UTC(2026, 9, 11, 21));
  });
});
