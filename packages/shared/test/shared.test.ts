import { describe, expect, it } from 'vitest';
import { isMobileE164, isUuidv7, normalizePhone, uuidv7 } from '../src/index.ts';

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
