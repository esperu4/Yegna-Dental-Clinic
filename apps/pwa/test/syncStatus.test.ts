import { describe, expect, it } from 'vitest';
import type { OpResult } from '@yegna/shared/client';
import { SummaryBuilder, notificationTarget, pillState, somethingHappened } from '../src/lib/syncStatus.ts';

const base = {
  state: 'idle' as const,
  lastError: null,
  offlineSince: null,
  pendingCount: 0,
  lastSyncedAt: 100,
  heldUntil: null,
};

describe('pillState (PRD §7.6)', () => {
  it('shows the most urgent of the four states', () => {
    expect(pillState(base)).toEqual({ kind: 'synced', at: 100 });
    expect(pillState({ ...base, pendingCount: 3 })).toEqual({ kind: 'waiting', count: 3, heldUntil: null });
    expect(pillState({ ...base, pendingCount: 3, state: 'offline', offlineSince: 50 })).toEqual({
      kind: 'offline',
      since: 50,
    });
    expect(pillState({ ...base, state: 'error', lastError: 'server_error', pendingCount: 3 })).toEqual({
      kind: 'problem',
      reason: 'server_error',
    });
  });

  it('keeps showing offline or the problem while a retry runs (never "Synced" meanwhile)', () => {
    expect(pillState({ ...base, state: 'syncing', offlineSince: 50 })).toEqual({
      kind: 'offline',
      since: 50,
    });
    expect(pillState({ ...base, state: 'syncing', lastError: 'server_error' })).toEqual({
      kind: 'problem',
      reason: 'server_error',
    });
  });

  it('says "not synced yet" before the first sync on this phone', () => {
    expect(pillState({ ...base, lastSyncedAt: null })).toEqual({ kind: 'starting' });
  });
});

describe('sync summary (PRD §7.7)', () => {
  const sent = new Map([
    ['o1', { entity: 'bookings' as const, entityId: 'b1' }],
    ['o2', { entity: 'bookings' as const, entityId: 'b1' }], // a second op on the same booking
    ['o3', { entity: 'bookings' as const, entityId: 'b2' }],
    ['o4', { entity: 'patients' as const, entityId: 'p1' }],
    ['o5', { entity: 'bookings' as const, entityId: 'b3' }],
  ]);
  const results: OpResult[] = [
    { opId: 'o1', outcome: 'applied', version: 1 },
    { opId: 'o2', outcome: 'applied', version: 2 },
    { opId: 'o3', outcome: 'clash', version: 3, winner: 'w' },
    { opId: 'o4', outcome: 'applied', version: 4 },
    { opId: 'o5', outcome: 'rejected', reason: 'patient_not_found' },
  ];

  it('counts distinct bookings sent, and bookings to fix including refused ones', () => {
    const b = new SummaryBuilder();
    b.add({ results, sent, newFromOthers: { hana: 2 } });
    expect(b.summary).toEqual({ bookingsSent: 2, fromOthers: { hana: 2 }, toFix: 2 });
    expect(notificationTarget(b.summary, true)).toBe('fix');
  });

  it('adds up the rounds of one run; a refused booking alone still counts as something', () => {
    const b = new SummaryBuilder();
    b.add({ results: [], sent, newFromOthers: { x: 1 } });
    b.add({ results: [], sent, newFromOthers: { x: 1 } });
    expect(b.summary.fromOthers).toEqual({ x: 2 });
    expect(notificationTarget(b.summary, true)).toBe('approvals');
    expect(notificationTarget(b.summary, false)).toBe('today');

    const refused = new SummaryBuilder();
    refused.add({ results: [results[4]!], sent, newFromOthers: {} });
    expect(somethingHappened(refused.summary)).toBe(true);
    expect(somethingHappened(new SummaryBuilder().summary)).toBe(false);
  });
});
