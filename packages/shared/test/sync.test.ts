import { describe, expect, it } from 'vitest';
import { DEFAULT_WEEKLY_HOURS } from '@yegna/time';
import { MAX_OPS_PER_SYNC, parseOpFields, rowKey, syncRequestSchema, uuidv7 } from '../src/index.ts';

const AT_10 = Date.UTC(2026, 10, 12, 7, 0);

function op(over: Record<string, unknown> = {}) {
  return {
    opId: uuidv7(),
    entity: 'patients',
    entityId: uuidv7(),
    kind: 'create',
    fields: { name: 'Hana', phoneE164: '+251911234567' },
    baseVersion: null,
    at: AT_10,
    userId: uuidv7(),
    ...over,
  };
}

describe('syncRequestSchema', () => {
  const req = (ops: unknown[]) => ({ deviceId: uuidv7(), cursor: 0, ops });

  it('accepts a well-formed request', () => {
    expect(syncRequestSchema.safeParse(req([op(), op()])).success).toBe(true);
  });

  it(`caps a request at ${MAX_OPS_PER_SYNC} ops`, () => {
    const ops = Array.from({ length: MAX_OPS_PER_SYNC + 1 }, () => op());
    expect(syncRequestSchema.safeParse(req(ops)).success).toBe(false);
  });

  it('refuses the same opId twice in one request', () => {
    const one = op();
    expect(syncRequestSchema.safeParse(req([one, one])).success).toBe(false);
  });

  it('refuses unknown entities and extra keys', () => {
    expect(syncRequestSchema.safeParse(req([op({ entity: 'users' })])).success).toBe(false);
    expect(syncRequestSchema.safeParse(req([{ ...op(), extra: 1 }])).success).toBe(false);
    expect(syncRequestSchema.safeParse({ ...req([]), extra: 1 }).success).toBe(false);
  });
});

describe('parseOpFields', () => {
  const id = uuidv7();

  it('requires valid E.164 phones exactly as normalised on the device', () => {
    expect(parseOpFields('patients', 'create', id, { name: 'Hana', phoneE164: '+251911234567' })).toEqual({
      name: 'Hana',
      phoneE164: '+251911234567',
    });
    expect(parseOpFields('patients', 'create', id, { name: 'Hana', phoneE164: '0911234567' })).toBeNull();
    expect(parseOpFields('patients', 'create', id, { name: 'Hana', phoneE164: '+251811234567' })).toBeNull();
  });

  it('trims text and turns an empty note into null', () => {
    expect(parseOpFields('patients', 'update', id, { name: '  Hana ', note: '  ' })).toEqual({
      name: 'Hana',
      note: null,
    });
  });

  it('removes control characters and bidi overrides, keeping newlines in notes', () => {
    expect(
      parseOpFields('patients', 'update', id, { name: 'Ha\u202Ena\u0007', note: 'line 1\nline\u0000 2' }),
    ).toEqual({ name: 'Hana', note: 'line 1\nline 2' });
    expect(parseOpFields('patients', 'update', id, { name: '\u202E\u0007' })).toBeNull();
  });

  it('caps the patient note at 280 characters', () => {
    expect(parseOpFields('patients', 'update', id, { note: 'x'.repeat(280) })).not.toBeNull();
    expect(parseOpFields('patients', 'update', id, { note: 'x'.repeat(281) })).toBeNull();
  });

  it('refuses an empty update and unknown fields', () => {
    expect(parseOpFields('patients', 'update', id, {})).toBeNull();
    expect(parseOpFields('patients', 'update', id, { telegramChatId: '1' })).toBeNull();
  });

  it('checks entity ids per entity', () => {
    expect(parseOpFields('patients', 'delete', 'not-a-uuid', {})).toBeNull();
    expect(parseOpFields('dayRules', 'delete', '2026-11-12', {})).toEqual({});
    expect(parseOpFields('dayRules', 'delete', '2026-02-30', {})).toBeNull();
    expect(parseOpFields('settings', 'update', 'other', { unspecifiedDurationMin: 60 })).toBeNull();
  });

  describe('bookings', () => {
    const create = { patientId: uuidv7(), procedureId: null, startAt: AT_10, durationMin: 60 };

    it('accepts a create on the 15-minute grid', () => {
      expect(parseOpFields('bookings', 'create', id, create)).toEqual(create);
    });

    it('refuses off-grid starts and durations, and over-long bookings', () => {
      expect(parseOpFields('bookings', 'create', id, { ...create, startAt: AT_10 + 60_000 })).toBeNull();
      expect(parseOpFields('bookings', 'create', id, { ...create, durationMin: 50 })).toBeNull();
      expect(parseOpFields('bookings', 'create', id, { ...create, durationMin: 8 * 60 + 15 })).toBeNull();
    });

    it('never lets the device set the status on create', () => {
      expect(parseOpFields('bookings', 'create', id, { ...create, status: 'approved' })).toBeNull();
    });

    it('never deletes a booking (cancel instead)', () => {
      expect(parseOpFields('bookings', 'delete', id, {})).toBeNull();
    });

    it('does not mix a status change with a move', () => {
      expect(parseOpFields('bookings', 'update', id, { status: 'arrived' })).toEqual({ status: 'arrived' });
      expect(parseOpFields('bookings', 'update', id, { status: 'approved', startAt: AT_10 })).toBeNull();
    });

    it('accepts a cancel reason only with a cancel', () => {
      expect(parseOpFields('bookings', 'update', id, { status: 'cancelled', cancelReason: 'sick' })).toEqual({
        status: 'cancelled',
        cancelReason: 'sick',
      });
      expect(parseOpFields('bookings', 'update', id, { cancelReason: 'sick' })).toBeNull();
    });

    it('refuses statuses only the server sets', () => {
      for (const status of ['pending_approval', 'clash'])
        expect(parseOpFields('bookings', 'update', id, { status })).toBeNull();
    });
  });

  it('validates the weekly hours in settings', () => {
    const ok = { weeklyHours: DEFAULT_WEEKLY_HOURS };
    expect(parseOpFields('settings', 'update', 'settings', ok)).toEqual(ok);
    const bad = [...DEFAULT_WEEKLY_HOURS];
    bad[1] = { openAt: 600, closeAt: 540, lunchStart: null, lunchEnd: null };
    expect(parseOpFields('settings', 'update', 'settings', { weeklyHours: bad })).toBeNull();
    expect(parseOpFields('settings', 'delete', 'settings', {})).toBeNull();
  });

  it('checks block and day-rule ranges on create', () => {
    expect(parseOpFields('blocks', 'create', id, { startAt: AT_10, endAt: AT_10, reason: null })).toBeNull();
    expect(
      parseOpFields('dayRules', 'create', '2026-11-12', {
        openAt: 600,
        closeAt: 540,
        lunchStart: null,
        lunchEnd: null,
        closed: false,
        note: null,
      }),
    ).toBeNull();
  });
});

describe('rowKey', () => {
  it('keys day rules by date and everything else by id', () => {
    expect(rowKey('dayRules', { date: '2026-11-12' } as never)).toBe('2026-11-12');
    expect(rowKey('patients', { id: 'p1' } as never)).toBe('p1');
  });
});

describe('free text: broken characters', () => {
  it('drops half an emoji (a lone surrogate) from names', () => {
    const fields = parseOpFields('patients', 'create', '01900000-0000-7000-8000-000000000001', {
      name: 'Abebe \uD83D',
      phoneE164: '+251911234567',
    });
    expect(fields?.name).toBe('Abebe');
  });
});
