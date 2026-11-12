import { describe, expect, it } from 'vitest';
import type { PatientRow, ProcedureRow } from '@yegna/shared/client';
import { localToUtc } from '@yegna/time';
import {
  type ImportRowView,
  type RowDraft,
  initialDraft,
  mergeDrafts,
  openDrafts,
  planChanges,
  planRows,
  rowsToBook,
} from '../src/lib/imports.ts';

const meta = { version: 1, updatedAt: 0, updatedBy: null, deletedAt: null };
const abebe: PatientRow = {
  ...meta,
  id: 'p-abebe',
  name: 'Abebe Kebede',
  phoneE164: '+251911234567',
  note: null,
  telegramLinked: false,
};
const extraction: ProcedureRow = {
  ...meta,
  id: 'proc-x',
  nameAm: 'ማውጣት',
  nameEn: 'Extraction',
  code: 'X',
  durationMin: 45,
  color: '#c00',
  active: true,
  sort: 1,
};
const ctx = { patients: [abebe], procedures: [extraction], unspecifiedMin: 60 };

const row = (over: Partial<ImportRowView> = {}): ImportRowView => ({
  id: 'r1',
  dayText: 'Mon',
  timeText: '4',
  nameText: 'Abebe K.',
  phoneText: '0911234567',
  codeText: 'x',
  confidence: 0.9,
  match: 'existing',
  decision: null,
  startAt: localToUtc('2026-11-16', 10 * 60),
  patientId: 'p-abebe',
  duplicateOfId: null,
  needsCheck: false,
  bookingId: null,
  ...over,
});

const draft = (over: Partial<RowDraft> = {}): RowDraft => ({
  rowId: 'r1',
  decision: 'accept',
  date: '2026-11-16',
  startMin: 10 * 60,
  name: '',
  phone: '',
  patientId: null,
  procedureId: null,
  ...over,
});

describe('import review (PRD §12)', () => {
  it('starts from what was read: local date and time, matched patient, procedure by code', () => {
    expect(initialDraft(row(), [extraction])).toEqual({
      rowId: 'r1',
      decision: 'accept',
      date: '2026-11-16',
      startMin: 600,
      name: 'Abebe K.',
      phone: '0911234567',
      patientId: 'p-abebe',
      procedureId: 'proc-x',
    });
  });

  it('skips duplicates and unreadable rows by default; keeps a decision already made', () => {
    expect(initialDraft(row({ match: 'duplicate' }), []).decision).toBe('skip');
    expect(initialDraft(row({ match: 'unreadable', startAt: null }), []).decision).toBe('skip');
    expect(initialDraft(row({ match: 'duplicate', decision: 'accept' }), []).decision).toBe('accept');
    const noTime = initialDraft(row({ startAt: null, codeText: 'ZZ' }), [extraction]);
    expect([noTime.date, noTime.startMin, noTime.procedureId]).toEqual([null, null, null]);
  });

  it('books a matched patient with the procedure’s length, marked with its sheet row', () => {
    const plan = planRows([draft({ patientId: 'p-abebe', procedureId: 'proc-x' })], ctx);
    expect(plan.problems.size).toBe(0);
    expect(plan.rows).toEqual([
      {
        rowId: 'r1',
        patientId: 'p-abebe',
        newPatient: null,
        booking: {
          procedureId: 'proc-x',
          startAt: localToUtc('2026-11-16', 600),
          durationMin: 45,
          importRowId: 'r1',
        },
      },
    ]);
  });

  it('finds an existing patient by phone, or plans a new one (once per phone on a sheet)', () => {
    const plan = planRows(
      [
        draft({ rowId: 'a', phone: '0911 23 45 67', name: 'Abebe Kebede' }),
        draft({ rowId: 'b', phone: '0922000111', name: 'Hana T.' }),
        draft({ rowId: 'c', phone: '+251922000111', name: 'hana t.', startMin: 11 * 60 }),
      ],
      ctx,
    );
    expect(plan.problems.size).toBe(0);
    expect(
      plan.rows.map((r) => [r.patientId, r.newPatient?.phoneE164 ?? null, r.booking.durationMin]),
    ).toEqual([
      ['p-abebe', null, 60],
      [null, '+251922000111', 60],
      [null, '+251922000111', 60],
    ]);
  });

  it('refuses rows that cannot become a booking, and ignores skipped ones', () => {
    const plan = planRows(
      [
        draft({ rowId: 'date', date: null }),
        draft({ rowId: 'time', startMin: null }),
        draft({ rowId: 'empty', phone: ' ' }),
        draft({ rowId: 'bad', phone: '12', name: 'X' }),
        draft({ rowId: 'name', phone: '0933000000' }),
        draft({ rowId: 'belongs', phone: '0911234567', name: 'Someone Else' }),
        draft({ rowId: 'skip', decision: 'skip', date: null }),
        // A matched patient deleted since: the phone decides again.
        draft({ rowId: 'gone', patientId: 'p-deleted', phone: '' }),
      ],
      { ...ctx, deletedPatientIds: new Set(['p-deleted']) },
    );
    expect(plan.rows).toEqual([]);
    expect(Object.fromEntries(plan.problems)).toEqual({
      date: { kind: 'date' },
      time: { kind: 'time' },
      empty: { kind: 'phoneEmpty' },
      bad: { kind: 'phone' },
      name: { kind: 'name' },
      belongs: { kind: 'phoneBelongs', name: 'Abebe Kebede' },
      gone: { kind: 'phoneEmpty' },
    });
  });

  it('refuses one phone written with two different names on the same sheet', () => {
    const plan = planRows(
      [
        draft({ rowId: 'a', phone: '0944000000', name: 'Selam' }),
        draft({ rowId: 'b', phone: '0944000000', name: 'Marta' }),
      ],
      ctx,
    );
    expect(plan.rows.map((r) => r.rowId)).toEqual(['a']);
    expect(plan.problems.get('b')).toEqual({ kind: 'phoneBelongs', name: 'Selam' });
  });

  it('queues a new patient once, then every booking pointing at it', async () => {
    const plan = planRows(
      [
        draft({ rowId: 'b', phone: '0922000111', name: 'Hana' }),
        draft({ rowId: 'c', phone: '0922000111', name: 'Hana', startMin: 11 * 60 }),
        draft({ rowId: 'a', patientId: 'p-abebe' }),
      ],
      ctx,
    );
    let n = 0;
    const changes = planChanges(plan.rows, () => `new-${++n}`);
    expect(
      changes.map((c) => [
        c.entity,
        c.entityId ?? null,
        c.fields.patientId ?? c.fields.name,
        c.fields.importRowId ?? null,
      ]),
    ).toEqual([
      ['patients', 'new-1', 'Hana', null],
      ['bookings', null, 'new-1', 'b'],
      ['bookings', null, 'new-1', 'c'],
      ['bookings', null, 'p-abebe', 'a'],
    ]);
  });

  it('keeps the reviewer’s edits when the open rows are drawn again (a sync must not undo them)', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })];
    const first = mergeDrafts(new Map(), rows, [extraction]);
    const edited = new Map(first).set('a', { ...first.get('a')!, startMin: 11 * 60, decision: 'skip' });
    expect(mergeDrafts(edited, [row({ id: 'a' }), row({ id: 'b' })], [extraction])).toBe(edited);
    // 'a' is sent (no longer open), 'c' opens: only open rows are shown.
    const sent = mergeDrafts(edited, [row({ id: 'b' }), row({ id: 'c' })], [extraction]);
    expect(openDrafts(sent, [row({ id: 'b' }), row({ id: 'c' })]).map((d) => d.rowId)).toEqual(['b', 'c']);
    expect(sent.get('c')).toMatchObject({ startMin: 600, decision: 'accept' });
    // The server refused 'a': it comes back with the reviewer's corrections, not what was read.
    const back = mergeDrafts(sent, [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })], [extraction]);
    expect(back).toBe(sent);
    expect(back.get('a')).toMatchObject({ startMin: 660, decision: 'skip' });
  });

  it('keeps a patient matched by the server that this phone has not pulled yet', () => {
    const plan = planRows([draft({ patientId: 'p-not-here-yet' })], ctx);
    expect(plan.rows.map((r) => r.patientId)).toEqual(['p-not-here-yet']);
  });

  it('offers rows still to book: none booked or queued; on a reviewed sheet only accepted ones', () => {
    const detail = (status: 'read' | 'reviewed') => ({
      id: 'i1',
      status,
      template: 'F',
      sheetId: null,
      provider: null,
      createdAt: 0,
      rows: [
        row({ id: 'booked', bookingId: 'b1', decision: 'accept' }),
        row({ id: 'queued', decision: 'accept' }),
        row({ id: 'refused', decision: 'accept' }),
        row({ id: 'skipped', decision: 'skip' }),
        row({ id: 'new' }),
      ],
    });
    const queued = new Set(['queued']);
    expect(rowsToBook(detail('read'), queued).map((r) => r.id)).toEqual(['refused', 'skipped', 'new']);
    expect(rowsToBook(detail('reviewed'), queued).map((r) => r.id)).toEqual(['refused']);
  });
});
