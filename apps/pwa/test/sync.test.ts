import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { OpResult, SyncOp, SyncRequest, SyncResponse } from '@yegna/shared/client';
import { type ApiOptions, api } from '../src/lib/api.ts';
import { YegnaDb } from '../src/lib/db.ts';
import { applyLocally } from '../src/lib/localOps.ts';
import { createSession } from '../src/lib/session.ts';
import { createSync } from '../src/lib/sync.ts';

const USER_ID = '01900000-0000-7000-8000-000000000001';
const enrolled = {
  token: 'a'.repeat(64),
  deviceId: '01900000-0000-7000-8000-0000000000d1',
  user: {
    id: USER_ID,
    name: 'Hana',
    role: 'staff' as const,
    locale: 'am' as const,
    calendar: 'ethiopian' as const,
  },
};

/** A tiny in-memory `/sync`: applies fields, versions every write, rejects names equal to "REJECT". */
class FakeServer {
  version = 0;
  rows = new Map<string, Record<string, unknown>>();
  requests: SyncRequest[] = [];
  offline = false;
  status = 200;
  pageSize = Infinity;
  /** Answer at most this many ops per request (the real server stops at its query budget). */
  answerLimit = Infinity;
  /** Simulates the daily op budget: answer no ops and tell the device to wait an hour. */
  holdOps = false;
  /** Runs while a request is "in flight", before the response is built. */
  duringRequest: (() => Promise<void>) | null = null;

  async handle(req: SyncRequest): Promise<SyncResponse> {
    this.requests.push(structuredClone(req));
    if (this.duringRequest) {
      const hook = this.duringRequest;
      this.duringRequest = null;
      await hook();
    }
    const results: OpResult[] = this.holdOps
      ? []
      : req.ops.slice(0, this.answerLimit).map((op) => this.apply(op));
    const changed = [...this.rows.values()]
      .filter((r) => (r.version as number) > req.cursor)
      .sort((a, b) => (a.version as number) - (b.version as number));
    const page = changed.slice(0, this.pageSize);
    const changes: SyncResponse['changes'] = {};
    for (const r of page) {
      const { entity, ...row } = r;
      ((changes as Record<string, unknown[]>)[entity as string] ??= []).push(row);
    }
    // Rejected ops: send the current row back, whatever its version.
    for (const [i, op] of req.ops.slice(0, results.length).entries()) {
      const current = this.rows.get(op.entityId);
      if (results[i]!.outcome === 'rejected' && current && !page.includes(current)) {
        const { entity, ...row } = current;
        ((changes as Record<string, unknown[]>)[entity as string] ??= []).push(row);
      }
    }
    return {
      results,
      changes,
      newCursor: page.length ? (page.at(-1)!.version as number) : req.cursor,
      more: changed.length > page.length,
      ...(this.holdOps ? { retryOpsAfterMs: 60 * 60_000 } : {}),
    };
  }

  apply(op: SyncOp): OpResult {
    if (op.fields.name === 'REJECT') return { opId: op.opId, outcome: 'rejected', reason: 'invalid' };
    if (op.fields.name === 'NEEDS_FIX') {
      this.apply({ ...op, fields: { ...op.fields, name: 'kept' } });
      return { opId: op.opId, outcome: 'needs_fixing', version: this.version, reason: 'after_close' };
    }
    if (op.fields.name === 'CLASH') {
      this.apply({ ...op, fields: { ...op.fields, name: 'clashed' } });
      return { opId: op.opId, outcome: 'clash', version: this.version, winner: 'w1' };
    }
    const version = ++this.version;
    const prev = this.rows.get(op.entityId);
    this.rows.set(op.entityId, {
      ...(prev ?? { entity: op.entity, id: op.entityId, note: null, telegramLinked: false }),
      ...op.fields,
      version,
      updatedAt: op.at,
      updatedBy: op.userId,
      deletedAt: op.kind === 'delete' ? op.at : null,
    });
    return { opId: op.opId, outcome: 'applied', version };
  }

  fetch = (async (url: string, init: RequestInit) => {
    if (this.offline) throw new TypeError('Failed to fetch');
    const path = new URL(url).pathname;
    if (path === '/enrol') return json(201, enrolled);
    if (this.status !== 200) return json(this.status, { error: 'revoked' });
    return json(200, await this.handle(JSON.parse(init.body as string)));
  }) as unknown as typeof fetch;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let n = 0;
async function setup() {
  const server = new FakeServer();
  const db = new YegnaDb(`sync-${n++}`);
  const session = createSession({ db, fetchImpl: server.fetch });
  await session.enrol({ name: 'Hana', pin: '4731', deviceLabel: 'x' });
  const sync = createSync({ db, session });
  return { server, db, session, sync };
}

const patient = (name = 'Abebe') => ({ name, phoneE164: '+251911234567' });

describe('device sync', () => {
  it('writes to the working copy and the outbox first, then settles with the server', async () => {
    const { server, db, sync } = await setup();
    server.offline = true;
    const op = await sync.write('patients', 'create', patient());
    await sync.syncNow();

    expect(await db.patients.get(op.entityId)).toMatchObject({
      name: 'Abebe',
      provisional: true,
      version: 0,
    });
    expect(await db.outbox.count()).toBe(1);
    expect(sync.state.value).toBe('offline');
    expect(sync.pendingCount.value).toBe(1);

    server.offline = false;
    await sync.syncNow();
    expect(await db.outbox.count()).toBe(0);
    expect(await db.patients.get(op.entityId)).toMatchObject({
      name: 'Abebe',
      provisional: false,
      version: 1,
    });
    expect(await db.getMeta('syncCursor')).toBe(1);
    expect(sync.state.value).toBe('idle');
    expect(sync.pendingCount.value).toBe(0);
  });

  it('sends ops in the order they were made, with the version each edit was based on', async () => {
    const { server, sync } = await setup();
    server.offline = true;
    const created = await sync.write('patients', 'create', patient('A'));
    await sync.write('patients', 'update', { name: 'B' }, created.entityId);
    server.offline = false;
    await sync.syncNow();
    await sync.write('patients', 'update', { name: 'C' }, created.entityId);
    await sync.syncNow();

    const sent = server.requests.flatMap((r) => r.ops);
    expect(sent.map((o) => [o.kind, o.fields.name, o.baseVersion])).toEqual([
      ['create', 'A', null],
      ['update', 'B', null], // based on a row the server had not seen yet
      ['update', 'C', 2],
    ]);
  });

  it('keeps a newer local edit when an older server row arrives (replays pending ops)', async () => {
    const { server, db, sync } = await setup();
    const op = await sync.write('patients', 'create', patient('First'));
    await sync.syncNow();
    // While the next request is in flight, the user edits again.
    server.duringRequest = async () => {
      await db.outbox.add({
        op: {
          ...op,
          opId: '01900000-0000-7000-8000-0000000000aa',
          kind: 'update',
          fields: { name: 'Newest' },
          baseVersion: 1,
        },
      });
    };
    await sync.write('patients', 'update', { name: 'Second' }, op.entityId);
    await sync.syncNow();
    expect(await db.patients.get(op.entityId)).toMatchObject({ name: 'Newest' });
    await sync.syncNow();
    expect(await db.patients.get(op.entityId)).toMatchObject({ name: 'Newest', provisional: false });
  });

  it('rolls back a rejected create and reports it', async () => {
    const { db, sync } = await setup();
    const op = await sync.write('patients', 'create', patient('REJECT'));
    await sync.syncNow();
    expect(await db.patients.get(op.entityId)).toBeUndefined();
    const notice = {
      opId: op.opId,
      kind: 'rejected',
      entity: 'patients',
      entityId: op.entityId,
      reason: 'invalid',
      fields: {}, // patient details are never kept on a notice (ADR 0007)
      at: expect.any(Number),
    };
    expect(sync.notices.value).toEqual([notice]);
    // Kept on the device with what was entered, so it survives a reload and can be re-done.
    const afterReload = createSync({ db, session: sync_session(db) });
    await afterReload.refresh();
    expect(afterReload.notices.value).toEqual([notice]);
    await sync.dismissNotice(op.opId);
    expect(sync.notices.value).toEqual([]);
  });

  it('restores the server row after a rejected update', async () => {
    const { db, sync } = await setup();
    const op = await sync.write('patients', 'create', patient('Kept'));
    await sync.syncNow();
    await sync.write('patients', 'update', { name: 'REJECT' }, op.entityId);
    await sync.syncNow();
    expect(await db.patients.get(op.entityId)).toMatchObject({ name: 'Kept', provisional: false });
  });

  it('keeps pulling while the server says there is more', async () => {
    const { server, db, sync } = await setup();
    server.offline = true;
    for (let i = 0; i < 5; i++) await sync.write('patients', 'create', patient(`P${i}`));
    server.offline = false;
    server.pageSize = 2;
    await sync.syncNow();
    expect(await db.patients.count()).toBe(5);
    expect(await db.getMeta('syncCursor')).toBe(5);
  });

  it('wipes the device when the server says it was revoked (PRD §7.9)', async () => {
    const { server, db, session, sync } = await setup();
    await sync.write('patients', 'create', patient());
    server.status = 401;
    await sync.syncNow();
    expect(session.status.value).toBe('signedOut');
    expect(session.notice.value).toBe('revoked');
    expect(await db.patients.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
});

describe('device sync: status and summary (PRD §7.6, §7.7)', () => {
  it('remembers when the phone went offline, and clears it once a sync works again', async () => {
    let clock = 5_000;
    const { server, db, session } = await setup();
    const sync = createSync({ db, session, now: () => clock });
    server.offline = true;
    await sync.syncNow();
    expect(sync.offlineSince.value).toBe(5_000);
    clock = 9_000;
    await sync.syncNow(); // still offline: keeps the first time
    expect(sync.offlineSince.value).toBe(5_000);
    server.offline = false;
    await sync.syncNow();
    expect(sync.offlineSince.value).toBeNull();
    expect(sync.lastSyncedAt.value).toBe(9_000);
  });

  it('clears the offline time when the server answers, even with an error', async () => {
    let clock = 5_000;
    const { server, db, session } = await setup();
    const sync = createSync({ db, session, now: () => clock });
    server.offline = true;
    await sync.syncNow();
    server.offline = false;
    server.status = 500;
    await sync.syncNow();
    expect(sync.offlineSince.value).toBeNull();
    expect(sync.state.value).toBe('error');
    clock = 20_000;
    server.offline = true;
    await sync.syncNow();
    expect(sync.offlineSince.value).toBe(20_000); // not the old 5_000
  });

  it('remembers the last sync time when the app is reopened', async () => {
    const clock = 7_000;
    const { db, session } = await setup();
    await createSync({ db, session, now: () => clock }).syncNow();
    const reopened = createSync({ db, session, now: () => clock });
    expect(reopened.lastSyncedAt.value).toBeNull();
    await reopened.refresh();
    expect(reopened.lastSyncedAt.value).toBe(7_000);
  });

  it('does not count the first fill as "new from" anyone', async () => {
    const { server, db, session } = await setup();
    server.rows.set('b-other', {
      entity: 'bookings',
      id: 'b-other',
      createdBy: 'someone-else',
      version: ++server.version,
      updatedAt: 1,
      updatedBy: 'someone-else',
      deletedAt: null,
    });
    const summaries: unknown[] = [];
    const sync = createSync({ db, session, onSummary: (s) => summaries.push(s) });
    await sync.syncNow(); // first fill
    expect(summaries).toEqual([]);
    server.rows.set('b-new', {
      entity: 'bookings',
      id: 'b-new',
      createdBy: 'someone-else',
      version: ++server.version,
      updatedAt: 1,
      updatedBy: 'someone-else',
      deletedAt: null,
    });
    await sync.syncNow();
    expect(summaries).toEqual([{ bookingsSent: 0, fromOthers: { 'someone-else': 1 }, toFix: 0 }]);
  });

  it('reports a summary only when something happened', async () => {
    const { db, session } = await setup();
    const summaries: unknown[] = [];
    const sync = createSync({ db, session, onSummary: (s) => summaries.push(s) });
    await sync.syncNow();
    expect(summaries).toEqual([]);
    await sync.write('bookings', 'create', {
      patientId: 'p',
      procedureId: null,
      startAt: 1,
      durationMin: 60,
      name: 'x',
    });
    await sync.syncNow();
    expect(summaries).toEqual([{ bookingsSent: 1, fromOthers: {}, toFix: 0 }]);
  });
});

describe('device sync: robustness', () => {
  it('keeps unanswered ops in the outbox and sends them in the next round', async () => {
    const { server, db, sync } = await setup();
    server.offline = true;
    for (let i = 0; i < 5; i++) await sync.write('patients', 'create', patient(`P${i}`));
    server.offline = false;
    server.answerLimit = 2;
    await sync.syncNow();
    expect(await db.outbox.count()).toBe(0);
    // (Requests with no ops are plain pulls, e.g. the follow-up run the background writes asked for.)
    expect(server.requests.map((r) => r.ops.length).filter((n) => n > 0)).toEqual([5, 3, 1]);
  });

  it('records a clash as a notice (PRD §7.5)', async () => {
    const { sync } = await setup();
    const op = await sync.write('patients', 'create', patient('CLASH'));
    await sync.syncNow();
    expect(sync.notices.value).toEqual([
      expect.objectContaining({ opId: op.opId, kind: 'clash', winner: 'w1' }),
    ]);
  });

  it('records a booking kept as needs fixing as a notice with its reason (ADR 0007)', async () => {
    const { db, sync } = await setup();
    const op = await sync.write('patients', 'create', patient('NEEDS_FIX'));
    await sync.syncNow();
    expect(sync.notices.value).toEqual([
      expect.objectContaining({ opId: op.opId, kind: 'needs_fixing', reason: 'after_close' }),
    ]);
    // Kept, not rolled back.
    expect(await db.patients.get(op.entityId)).toMatchObject({ provisional: false });
  });

  it('never replaces a row with an older server version', async () => {
    const { db, sync } = await setup();
    const op = await sync.write('patients', 'create', patient('A'));
    await sync.syncNow();
    await db.patients.update(op.entityId, { version: 99, name: 'Newer' });
    await db.setMeta('syncCursor', 0); // replay old changes, as a late response would
    await sync.syncNow();
    expect(await db.patients.get(op.entityId)).toMatchObject({ version: 99, name: 'Newer' });
    expect(await db.getMeta('syncCursor')).toBe(1);
  });

  it('keeps a tombstone (no content) so a late, older response cannot bring the row back', async () => {
    const { server, db, sync } = await setup();
    const op = await sync.write('patients', 'create', patient('Gone'));
    await sync.syncNow();
    const tombstone = {
      id: op.entityId,
      version: ++server.version,
      updatedAt: 1,
      updatedBy: null,
      deletedAt: 1,
    };
    server.rows.set(op.entityId, { entity: 'patients', ...tombstone });
    await sync.syncNow();
    expect(await db.patients.get(op.entityId)).toEqual({ ...tombstone, provisional: false });
    // A response from before the delete arrives late (another tab): it is ignored.
    await db.setMeta('syncCursor', 0);
    server.rows.set(op.entityId, {
      entity: 'patients',
      ...patient('Gone'),
      id: op.entityId,
      version: 1,
      updatedAt: 1,
      updatedBy: null,
      deletedAt: null,
    });
    await sync.syncNow();
    expect(await db.patients.get(op.entityId)).toEqual({ ...tombstone, provisional: false });
  });

  it('drops booking notices about a patient when the patient is deleted', async () => {
    const { server, db, sync } = await setup();
    const p = await sync.write('patients', 'create', patient('Soon Gone'));
    await sync.syncNow();
    await db.notices.put({
      opId: 'n1',
      kind: 'rejected',
      entity: 'bookings',
      entityId: 'b1',
      reason: 'patient_not_found',
      fields: { patientId: p.entityId, note: 'private' },
      at: Date.now(),
    });
    server.rows.set(p.entityId, {
      entity: 'patients',
      id: p.entityId,
      version: ++server.version,
      updatedAt: 1,
      updatedBy: null,
      deletedAt: 1,
    });
    await sync.syncNow();
    expect(await db.notices.count()).toBe(0);
  });

  it('does not replay a pending edit onto a tombstone, and refuses new edits to a deleted row', async () => {
    const { server, db, sync } = await setup();
    const op = await sync.write('patients', 'create', patient('Gone'));
    await sync.syncNow();
    server.offline = true;
    await sync.write('patients', 'update', { note: 'edited offline' }, op.entityId);
    server.offline = false;
    server.rows.set(op.entityId, {
      entity: 'patients',
      id: op.entityId,
      version: ++server.version,
      updatedAt: 1,
      updatedBy: null,
      deletedAt: 1,
    });
    server.answerLimit = 0; // the edit stays pending while the tombstone arrives
    await sync.syncNow();
    const row = await db.patients.get(op.entityId);
    expect(row).toMatchObject({ deletedAt: 1 });
    expect(row).not.toHaveProperty('note');
    await expect(sync.write('patients', 'update', { note: 'again' }, op.entityId)).rejects.toThrow(
      'row deleted',
    );
  });

  it('only pulls while the server holds its ops back, then sends them again', async () => {
    let clock = 1_000_000;
    const { server, db, session } = await setup();
    const sync = createSync({ db, session, now: () => clock });
    server.holdOps = true;
    await sync.write('patients', 'create', patient());
    await sync.syncNow();
    expect(await db.outbox.count()).toBe(1);
    server.holdOps = false;
    const before = server.requests.length;
    await sync.syncNow();
    expect(server.requests.slice(before).every((r) => r.ops.length === 0)).toBe(true);
    clock += 61 * 60_000;
    await sync.syncNow();
    expect(await db.outbox.count()).toBe(0);
  });

  it('forgets notices after 30 days', async () => {
    // Real time: other sync instances on this store (they share its broadcasts) use the real clock.
    let clock = Date.now();
    const { db, session } = await setup();
    const sync = createSync({ db, session, now: () => clock });
    await sync.write('patients', 'create', patient('REJECT'));
    await sync.syncNow();
    expect(sync.notices.value).toHaveLength(1);
    clock += 31 * 86_400_000;
    await sync.refresh();
    expect(sync.notices.value).toEqual([]);
  });

  it('clears "not sent yet" when the answer arrives after the row was already pulled', async () => {
    const { server, db, sync } = await setup();
    server.offline = true;
    const op = await sync.write('patients', 'create', patient());
    await sync.syncNow();
    // The other engine on this phone (service worker) pulled the row at the op's version while the
    // op was still waiting; the answer to the op comes later, from the server's stored result.
    await db.patients.update(op.entityId, { version: 7 });
    await db.setMeta('syncCursor', 7);
    expect((await db.patients.get(op.entityId))?.provisional).toBe(true);
    server.offline = false;
    // The server's row at version 7 (its own updatedAt, not the phone's).
    const serverRow = {
      id: op.entityId,
      ...patient(),
      note: null,
      telegramLinked: false,
      version: 7,
      updatedAt: 123,
      updatedBy: USER_ID,
      deletedAt: null,
    };
    server.handle = async (req) => ({
      results: req.ops.map((o) => ({ opId: o.opId, outcome: 'applied' as const, version: 7 })),
      changes: req.cursor < 7 ? { patients: [serverRow] } : {},
      newCursor: Math.max(req.cursor, 7),
      more: false,
    });
    await sync.syncNow();
    // The phone pulled the row again rather than trusting its own copy.
    expect(await db.patients.get(op.entityId)).toEqual({ ...serverRow, provisional: false });
    expect(await db.getMeta('syncCursor')).toBe(7);
  });

  it('never steps back a row that has edits waiting either', async () => {
    const { server, db, sync } = await setup();
    const op = await sync.write('patients', 'create', patient('Abebe'));
    await sync.syncNow();
    // The phone holds version 10 (pulled by the other engine) with an edit still waiting.
    await db.patients.update(op.entityId, { version: 10 });
    server.holdOps = true;
    await sync.write('patients', 'update', { name: 'Abebe K.' }, op.entityId);
    // A late response still carries version 9.
    server.handle = async (req) => ({
      results: [],
      changes: {
        patients: [
          { id: op.entityId, ...patient('Old'), note: null, telegramLinked: false, version: 9 } as never,
        ],
      },
      newCursor: req.cursor,
      more: false,
      retryOpsAfterMs: 60_000,
    });
    await sync.syncNow();
    expect(await db.patients.get(op.entityId)).toMatchObject({ version: 10, name: 'Abebe K.' });
  });

  describe('bookings outside what the device keeps (PRD §7.1)', () => {
    const day = 86_400_000;
    const serverBooking = (id: string, startAt: number, version: number) => ({
      id,
      patientId: 'p1',
      procedureId: null,
      startAt,
      durationMin: 30,
      status: 'approved' as const,
      approvedBy: null,
      approvedAt: null,
      patientConfirmedAt: null,
      callHandledAt: null,
      callHandledBy: null,
      callTriedAt: null,
      source: 'app' as const,
      cancelReason: null,
      clashWithId: null,
      note: null,
      createdBy: 'someone-else',
      version,
      updatedAt: 0,
      updatedBy: null,
      deletedAt: null,
    });

    async function answerWith(bookings: ReturnType<typeof serverBooking>[]) {
      const { server, db, session } = await setup();
      const summaries: unknown[] = [];
      const sync = createSync({ db, session, onSummary: (s) => summaries.push(s) });
      await db.setMeta('syncFilled', true);
      await db.setMeta('syncCursor', 8);
      server.handle = async (req) => ({
        results: [],
        changes: { bookings: bookings as never },
        newCursor: Math.max(req.cursor, ...bookings.map((b) => b.version)),
        more: false,
      });
      await sync.syncNow();
      return { db, summaries };
    }

    it('does not bring back a dropped booking from a late, older response', async () => {
      // The device pulled up to 8 and dropped this booking; a slow response still carries version 5.
      const { db } = await answerWith([serverBooking('late', Date.now() + day, 5)]);
      expect(await db.bookings.get('late')).toBeUndefined();
    });

    it('neither keeps nor announces an old booking changed on the server', async () => {
      const { db, summaries } = await answerWith([serverBooking('old', Date.now() - 40 * day, 9)]);
      expect(await db.bookings.get('old')).toBeUndefined();
      expect(summaries).toEqual([]);
    });

    it('still takes a new booking in the window', async () => {
      const { db, summaries } = await answerWith([serverBooking('new', Date.now() + day, 9)]);
      expect(await db.bookings.get('new')).toBeDefined();
      expect(summaries).toHaveLength(1);
    });
  });

  it('drops bookings older than the window after a sync, keeping ones with a change waiting (PRD §7.1)', async () => {
    const { server, db, sync } = await setup();
    const booking = (id: string, startAt: number) => ({
      id,
      patientId: 'p1',
      procedureId: null,
      startAt,
      durationMin: 30,
      status: 'approved',
      note: null,
      version: 1,
      updatedAt: 0,
      updatedBy: null,
      deletedAt: null,
    });
    const day = 86_400_000;
    await db.bookings.bulkPut([
      booking('old', Date.now() - 40 * day),
      booking('old-edited', Date.now() - 40 * day),
      booking('in-window', Date.now() - 20 * day),
    ] as never);
    // The server holds the edit back: it stays in the outbox, so its booking stays too.
    server.holdOps = true;
    await sync.write('bookings', 'update', { note: 'x-ray done' }, 'old-edited');
    await sync.syncNow();
    expect((await db.bookings.toCollection().primaryKeys()).sort()).toEqual(['in-window', 'old-edited']);
  });

  it('asks for the first-fill window until the first full pull is done', async () => {
    const { server, sync } = await setup();
    await sync.syncNow();
    await sync.syncNow();
    expect(server.requests.map((r) => r.initial)).toEqual([true, false]);
  });

  it('treats an unreadable success response as a failed sync, keeping the outbox', async () => {
    const { db, session } = await setup();
    const brokenFetch = (async () =>
      new Response('<html>proxy</html>', { status: 200 })) as unknown as typeof fetch;
    const broken = createSync({
      db,
      session: Object.assign(Object.create(session), { authed: authedWith(session, brokenFetch) }),
    });
    await broken.write('patients', 'create', patient());
    await broken.syncNow();
    expect(await db.outbox.count()).toBe(1);
    expect(broken.state.value).toBe('offline');
  });
});

/** The same session, but its API calls go through `fetchImpl`. */
function authedWith(session: ReturnType<typeof createSession>, fetchImpl: typeof fetch) {
  return <T>(path: string, opts: Omit<ApiOptions, 'token'> = {}) =>
    api<T>(path, { ...opts, fetchImpl, token: session.current.value?.token ?? null });
}

/** A second session object over the same device storage (as after a reload). */
function sync_session(db: YegnaDb) {
  const s = createSession({ db });
  return s;
}

describe('applyLocally', () => {
  const op = (over: Partial<SyncOp>): SyncOp => ({
    opId: 'o',
    entity: 'bookings',
    entityId: 'b1',
    kind: 'create',
    fields: { patientId: 'p', procedureId: null, startAt: 1000, durationMin: 60 },
    baseVersion: null,
    at: 5,
    userId: USER_ID,
    ...over,
  });

  it('mirrors the server’s booking status on create', () => {
    expect(applyLocally(undefined, op({}), 'staff')).toMatchObject({
      status: 'pending_approval',
      provisional: true,
      version: 0,
    });
    expect(applyLocally(undefined, op({}), 'doctor')).toMatchObject({
      status: 'approved',
      approvedBy: USER_ID,
    });
  });

  it('sends a booking moved by Staff back for approval, but not a note change', () => {
    const approved = { ...applyLocally(undefined, op({}), 'doctor'), version: 3, provisional: false };
    expect(applyLocally(approved, op({ kind: 'update', fields: { note: 'x' } }), 'staff')).toMatchObject({
      status: 'approved',
    });
    expect(applyLocally(approved, op({ kind: 'update', fields: { startAt: 2000 } }), 'staff')).toMatchObject({
      status: 'pending_approval',
      startAt: 2000,
    });
  });

  it('re-checks a needs_fixing booking sent with its own time (same rule as the server)', () => {
    const fix = {
      ...applyLocally(undefined, op({}), 'staff'),
      status: 'needs_fixing',
      version: 2,
      provisional: false,
    };
    expect(applyLocally(fix, op({ kind: 'update', fields: { startAt: 1000 } }), 'staff')).toMatchObject({
      status: 'pending_approval',
    });
  });

  it('turns a delete into a tombstone', () => {
    expect(
      applyLocally({ id: 'p1', name: 'x' }, op({ entity: 'patients', kind: 'delete', fields: {} }), 'doctor'),
    ).toMatchObject({
      id: 'p1',
      deletedAt: 5,
      provisional: true,
    });
  });
});
