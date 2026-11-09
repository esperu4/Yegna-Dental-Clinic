import { describe, expect, it } from 'vitest';
import { isTrivialPin, newPinSchema, normalizeName, pinSchema } from '../src/index.ts';

describe('PIN rules', () => {
  it.each(['0000', '1111', '999999', '1234', '4321', '123456', '654321', '7890', '0987', '8901'])(
    '%s is trivial',
    (pin) => {
      expect(isTrivialPin(pin)).toBe(true);
      expect(newPinSchema.safeParse(pin).success).toBe(false);
      // Still accepted at sign-in, so existing PINs keep working.
      expect(pinSchema.safeParse(pin).success).toBe(true);
    },
  );

  it.each(['2580', '4731', '1235', '102938', '1122'])('%s is allowed', (pin) => {
    expect(isTrivialPin(pin)).toBe(false);
    expect(newPinSchema.safeParse(pin).success).toBe(true);
  });

  it('enforces 4–6 digits', () => {
    for (const bad of ['123', '1234567', '12a4', ' 2580'])
      expect(pinSchema.safeParse(bad).success).toBe(false);
  });
});

describe('normalizeName', () => {
  it('trims, collapses spaces and ignores Latin case', () => {
    expect(normalizeName('  Hana   BEKELE ')).toBe('hana bekele');
    expect(normalizeName('ሐና  በቀለ')).toBe('ሐና በቀለ');
  });
});
