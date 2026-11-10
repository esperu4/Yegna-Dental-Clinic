import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CLASH_STATUSES,
  DEVICE_DAILY_OPS,
  type EnrolResponse,
  type OpResult,
  type SyncOp,
  type SyncResponse,
  uuidv7,
} from '@yegna/shared';
import { addDays, localDateOf, localToUtc, weekdayOf } from '@yegna/time';
import { getDb } from '../src/lib/db.ts';
import { pull } from '../src/sync/pull.ts';
import { type Call, addStaff, caller, createTestEnv, resetDb, setupDoctor } from './helpers.ts';

let env: Env;
let dispose: () => Promise<void>;
let call: Call;
let doctor: EnrolResponse;
let staff: EnrolResponse;

beforeAll(async () => {
  ({ env, dispose } = await createTestEnv());
  call = caller(env);
});
afterAll(() => dispose());
beforeEach(async () => {
  await resetDb(env);
  doctor = await setupDoctor(call);
  await addStaff(call, doctor.token, 'Hana', '4731');
  const res = await call('POST', '/enrol', {
    body: { name: 'Hana', pin: '4731', deviceLabel: 'Front desk' },
  });
  staff = res.json as unknown as EnrolResponse;
});

/** The next Monday (clinic open 09:00–18:00, lunch 12–13) at `hh:mm` local, as UTC ms. */
function nextMonday(hh: number, mm = 0): number {
  let date = addDays(localDateOf(Date.now()), 1);
  while (weekdayOf(date) !== 1) date = addDays(date, 1);
  return localToUtc(date, hh * 60 + mm);
}

function op(
  as: EnrolResponse,
  entity: SyncOp['entity'],
  kind: SyncOp['kind'],
  fields: Record<string, unknown>,
  over: Partial<SyncOp> = {},
): SyncOp {
  return {
    opId: uuidv7(),
    entity,
    entityId: uuidv7(),
    kind,
    fields,
    baseVersion: null,
    at: Date.now(),
    userId: as.user.id,
    ...over,
  };
}

async function sync(as: EnrolResponse, ops: SyncOp[], cursor = 0, initial?: boolean) {
  const res = await call('POST', '/sync', {
    token: as.token,
    body: { deviceId: as.deviceId, cursor, ops, ...(initial === undefined ? {} : { initial }) },
  });
  return res as typeof res & { json: SyncResponse };
}

let phoneSeq = 0;
function newPatient(as: EnrolResponse, name = 'Abebe') {
  phoneSeq = (phoneSeq + 1) % 1_000_000;
  return op(as, 'patients', 'create', { name, phoneE164: `+251911${String(phoneSeq).padStart(6, '0')}` });
}

function newBooking(as: EnrolResponse, patientId: string, startAt: number, durationMin = 60) {
  return op(as, 'bookings', 'create', { patientId, procedureId: null, startAt, durationMin });
}

async function bookingStatus(id: string) {
  return (await env.DB.prepare('SELECT status, clash_with_id FROM bookings WHERE id = ?')
    .bind(id)
    .first()) as {
    status: string;
    clash_with_id: string | null;
  };
}

describe('POST /sync: access', () => {
  it('needs a device token', async () => {
    const res = await call('POST', '/sync', { body: { deviceId: doctor.deviceId, cursor: 0, ops: [] } });
    expect(res.status).toBe(401);
  });

  it('refuses a deviceId that is not the caller’s', async () => {
    const res = await call('POST', '/sync', {
      token: staff.token,
      body: { deviceId: doctor.deviceId, cursor: 0, ops: [] },
    });
    expect(res.status).toBe(403);
  });

  it('tells a revoked device to wipe itself (PRD §7.9)', async () => {
    await call('POST', `/admin/devices/${staff.deviceId}/revoke`, { token: doctor.token });
    const res = await sync(staff, []);
    expect(res.status).toBe(401);
    expect(res.json.error).toBe('revoked');
  });

  it('refuses a malformed envelope', async () => {
    const res = await call('POST', '/sync', {
      token: staff.token,
      body: { deviceId: staff.deviceId, cursor: -1, ops: [] },
    });
    expect(res.status).toBe(400);
  });

  it('rejects an op made for another user', async () => {
    const res = await sync(staff, [newPatient(doctor)]);
    expect(res.json.results[0]).toMatchObject({ outcome: 'rejected', reason: 'forbidden' });
  });
});

describe('POST /sync: ops', () => {
  it('applies a create and returns the row with a server version', async () => {
    const p = newPatient(staff, 'Abebe Kebede');
    const { json } = await sync(staff, [p]);
    expect(json.results).toEqual([{ opId: p.opId, outcome: 'applied', version: expect.any(Number) }]);
    const row = json.changes.patients?.find((r) => r.id === p.entityId);
    expect(row).toMatchObject({
      name: 'Abebe Kebede',
      telegramLinked: false,
      deletedAt: null,
      updatedBy: staff.user.id,
    });
    expect(row?.version).toBe((json.results[0] as { version: number }).version);
    expect(row).not.toHaveProperty('telegramChatId');
  });

  it('is idempotent by opId: a re-sent op returns its original result and writes nothing twice', async () => {
    const p = newPatient(staff);
    const first = await sync(staff, [p]);
    const again = await sync(staff, [p]);
    expect(again.json.results).toEqual(first.json.results);
    const audits = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ?')
      .bind(p.entityId)
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it('remembers rejections too, so a re-send gets the same answer', async () => {
    const bad = op(staff, 'patients', 'update', { name: 'X' });
    const first = await sync(staff, [bad]);
    expect(first.json.results[0]).toMatchObject({ outcome: 'rejected', reason: 'not_found' });
    // The patient now exists, but the op's answer does not change.
    await sync(staff, [
      op(staff, 'patients', 'create', { name: 'Y', phoneE164: '+251911000999' }, { entityId: bad.entityId }),
    ]);
    expect((await sync(staff, [bad])).json.results).toEqual(first.json.results);
  });

  it('rejects one bad op without failing the others', async () => {
    const good = newPatient(staff);
    const bad = op(staff, 'patients', 'create', { name: 'No phone' });
    const { json } = await sync(staff, [bad, good]);
    expect(json.results.map((r) => r.outcome)).toEqual(['rejected', 'applied']);
  });

  it('applies ops in order (create a patient, then book them)', async () => {
    const p = newPatient(staff);
    const b = newBooking(staff, p.entityId, nextMonday(10));
    const { json } = await sync(staff, [p, b]);
    expect(json.results.map((r) => r.outcome)).toEqual(['applied', 'applied']);
  });

  it('refuses a second patient with the same phone', async () => {
    const a = newPatient(staff);
    const b = op(staff, 'patients', 'create', { name: 'Other', phoneE164: a.fields.phoneE164 });
    const { json } = await sync(staff, [a, b]);
    expect(json.results[1]).toMatchObject({ outcome: 'rejected', reason: 'phone_taken' });
  });

  it('sends the server row back for a rejected op so the device can roll back', async () => {
    const p = newPatient(staff, 'Original');
    await sync(staff, [p]);
    const del = op(staff, 'patients', 'delete', {}, { entityId: p.entityId, baseVersion: 1 });
    const { json } = await sync(staff, [del], 1_000_000);
    expect(json.results[0]).toMatchObject({ outcome: 'rejected', reason: 'forbidden' });
    expect(json.changes.patients).toEqual([
      expect.objectContaining({ id: p.entityId, name: 'Original', deletedAt: null }),
    ]);
  });

  it('soft-deletes (tombstone) and pulls the tombstone', async () => {
    const p = newPatient(doctor);
    const created = await sync(doctor, [p]);
    const cursor = created.json.newCursor;
    const del = op(doctor, 'patients', 'delete', {}, { entityId: p.entityId, baseVersion: cursor });
    const { json } = await sync(doctor, [del], cursor);
    // Key and meta only: a deleted patient's name and phone are never sent again (PRD §18).
    expect(json.changes.patients).toEqual([
      {
        id: p.entityId,
        version: expect.any(Number),
        updatedAt: expect.any(Number),
        updatedBy: doctor.user.id,
        deletedAt: expect.any(Number),
      },
    ]);
  });

  it('never stores the values of a refused patient op (e.g. an edit arriving after the delete)', async () => {
    const p = newPatient(doctor, 'Gone Patient');
    await sync(doctor, [p]);
    await sync(doctor, [op(doctor, 'patients', 'delete', {}, { entityId: p.entityId })]);
    const late = op(
      staff,
      'patients',
      'update',
      { name: 'Late Edit', note: 'secret' },
      { entityId: p.entityId },
    );
    expect((await sync(staff, [late])).json.results[0]).toMatchObject({ reason: 'not_found' });
    const rows = await env.DB.prepare(
      "SELECT diff FROM audit_log WHERE entity = 'patients' AND entity_id = ?",
    )
      .bind(p.entityId)
      .all<{ diff: string | null }>();
    expect(rows.results.some((r) => r.diff && /Late Edit|secret|Gone/.test(r.diff))).toBe(false);
    expect(rows.results.some((r) => r.diff?.includes('fieldNames'))).toBe(true);
  });

  it('erases the deleted patient’s booking notes and their audit values, and syncs that', async () => {
    const p = newPatient(doctor, 'Note Person');
    const b = newBooking(doctor, p.entityId, nextMonday(10));
    b.fields.note = 'sister of Note Person, 0911 000 111';
    const created = await sync(doctor, [p, b]);
    await sync(doctor, [
      op(
        doctor,
        'bookings',
        'update',
        { status: 'cancelled', cancelReason: 'Note Person is ill' },
        { entityId: b.entityId },
      ),
    ]);
    const before = created.json.newCursor;
    const { json } = await sync(
      doctor,
      [op(doctor, 'patients', 'delete', {}, { entityId: p.entityId })],
      before,
    );
    const row = await env.DB.prepare('SELECT note, cancel_reason FROM bookings WHERE id = ?')
      .bind(b.entityId)
      .first();
    expect(row).toEqual({ note: null, cancel_reason: null });
    const audit = await env.DB.prepare(
      "SELECT diff FROM audit_log WHERE entity = 'bookings' AND entity_id = ?",
    )
      .bind(b.entityId)
      .all<{ diff: string | null }>();
    expect(audit.results.some((r) => r.diff?.includes('Note Person'))).toBe(false);
    // Devices receive the cleared booking.
    expect(json.changes.bookings).toEqual([
      expect.objectContaining({ id: b.entityId, note: null, cancelReason: null }),
    ]);
  });

  it('keeps free text off a deleted patient’s bookings when ops arrive late', async () => {
    const p = newPatient(doctor, 'Late Person');
    const b = newBooking(doctor, p.entityId, nextMonday(10));
    await sync(doctor, [p, b]);
    await sync(doctor, [op(doctor, 'patients', 'delete', {}, { entityId: p.entityId })]);
    // A note edit and a cancel made offline before the delete, and a new booking for them.
    const note = op(
      staff,
      'bookings',
      'update',
      { note: 'Late Person sister 0911' },
      { entityId: b.entityId },
    );
    const cancel = op(
      staff,
      'bookings',
      'update',
      { status: 'cancelled', cancelReason: 'Late Person moved away' },
      { entityId: b.entityId },
    );
    const create = newBooking(staff, p.entityId, nextMonday(11));
    create.fields.note = 'Late Person again';
    const { json } = await sync(staff, [note, cancel, create]);
    expect(json.results.map((r) => r.outcome)).toEqual(['applied', 'applied', 'rejected']);
    const row = await env.DB.prepare('SELECT status, note, cancel_reason FROM bookings WHERE id = ?')
      .bind(b.entityId)
      .first();
    expect(row).toEqual({ status: 'cancelled', note: null, cancel_reason: null });
    const audit = await env.DB.prepare('SELECT diff FROM audit_log WHERE diff IS NOT NULL').all<{
      diff: string;
    }>();
    expect(audit.results.some((r) => r.diff.includes('Late Person'))).toBe(false);
  });

  it('pulls every row of a version shared by more rows than a page', async () => {
    const p = newPatient(doctor, 'Many Bookings');
    const ops: SyncOp[] = [p];
    for (let i = 0; i < 6; i++) {
      const b = newBooking(doctor, p.entityId, nextMonday(9 + i));
      b.fields.note = `visit ${i}`;
      ops.push(b);
    }
    const created = await sync(doctor, ops);
    await sync(doctor, [op(doctor, 'patients', 'delete', {}, { entityId: p.entityId })]);
    // The erase gave all six bookings one version; pull it with pages of 2.
    const db = getDb(env.DB);
    let cursor = created.json.newCursor;
    const notes = new Map<string, unknown>();
    for (let more = true, rounds = 0; more && rounds < 20; rounds++) {
      const page = await pull(db, cursor, Date.now(), { pageSize: 2 });
      for (const b of page.changes.bookings ?? [])
        notes.set((b as { id: string }).id, (b as { note: unknown }).note);
      ({ more } = page);
      cursor = page.newCursor;
    }
    expect(notes.size).toBe(6);
    expect([...notes.values()].every((n) => n === null)).toBe(true);
  });

  it('erases a deleted patient’s details and audit values, and frees the phone (ADR 0007)', async () => {
    const p = newPatient(doctor, 'Erase Me');
    await sync(doctor, [
      p,
      op(doctor, 'patients', 'update', { note: 'allergic to x' }, { entityId: p.entityId }),
    ]);
    await sync(doctor, [op(doctor, 'patients', 'delete', {}, { entityId: p.entityId })]);
    const row = await env.DB.prepare(
      'SELECT name, phone_e164, note, telegram_chat_id, deleted_at FROM patients WHERE id = ?',
    )
      .bind(p.entityId)
      .first();
    expect(row).toEqual({
      name: '',
      phone_e164: '',
      note: null,
      telegram_chat_id: null,
      deleted_at: expect.any(Number),
    });
    const audits = await env.DB.prepare(
      "SELECT action, diff FROM audit_log WHERE entity = 'patients' AND entity_id = ?",
    )
      .bind(p.entityId)
      .all<{ action: string; diff: string | null }>();
    expect(audits.results.map((a) => a.action)).toEqual(['create', 'update', 'delete']);
    expect(audits.results.every((a) => a.diff === null || !/Erase Me|allergic|\+251/.test(a.diff))).toBe(
      true,
    );
    // The number is free for a new patient.
    const again = op(doctor, 'patients', 'create', { name: 'New Person', phoneE164: p.fields.phoneE164 });
    expect((await sync(doctor, [again])).json.results[0]?.outcome).toBe('applied');
  });

  it('records overwritten values when the device had not seen the latest version (PRD §7.4 step 3)', async () => {
    const p = newPatient(staff, 'First');
    const { json } = await sync(staff, [p]);
    const v1 = json.newCursor;
    await sync(doctor, [
      op(doctor, 'patients', 'update', { name: 'Doctor edit' }, { entityId: p.entityId, baseVersion: v1 }),
    ]);
    // Staff edits from the old version: last writer wins, the overwrite is audited.
    const late = await sync(staff, [
      op(staff, 'patients', 'update', { name: 'Staff edit' }, { entityId: p.entityId, baseVersion: v1 }),
    ]);
    expect(late.json.results[0]?.outcome).toBe('applied');
    const audit = await env.DB.prepare(
      "SELECT diff FROM audit_log WHERE entity_id = ? AND user_id = ? AND action = 'update'",
    )
      .bind(p.entityId, staff.user.id)
      .first<{ diff: string }>();
    expect(JSON.parse(audit!.diff)).toEqual({
      name: ['Doctor edit', 'Staff edit'],
      staleBase: [v1, expect.any(Number)],
    });
  });
});

describe('POST /sync: refusals and limits', () => {
  it('keeps the values of a refused booking in the audit log, so nothing entered is lost', async () => {
    const p = newPatient(staff);
    await sync(staff, [p]);
    const b = op(staff, 'bookings', 'create', {
      patientId: p.entityId,
      procedureId: uuidv7(), // a procedure that doesn't exist
      startAt: nextMonday(10),
      durationMin: 60,
    });
    await sync(staff, [b]);
    const audit = await env.DB.prepare('SELECT action, diff FROM audit_log WHERE entity_id = ?')
      .bind(b.entityId)
      .first<{ action: string; diff: string }>();
    expect(audit?.action).toBe('rejected:procedure_not_found');
    expect(JSON.parse(audit!.diff)).toEqual({ kind: 'create', fields: b.fields });
  });

  it('keeps only field names when the booking was refused because its patient is gone (ADR 0007)', async () => {
    const b = newBooking(staff, uuidv7(), nextMonday(10));
    await sync(staff, [b]);
    const audit = await env.DB.prepare('SELECT action, diff FROM audit_log WHERE entity_id = ?')
      .bind(b.entityId)
      .first<{ action: string; diff: string }>();
    expect(audit?.action).toBe('rejected:patient_not_found');
    expect(JSON.parse(audit!.diff)).toEqual({ kind: 'create', fieldNames: Object.keys(b.fields) });
  });

  it('does not store invalid ops (their answer follows from the op itself)', async () => {
    const bad = op(staff, 'patients', 'create', { name: 'No phone' });
    expect((await sync(staff, [bad])).json.results[0]).toMatchObject({ reason: 'invalid' });
    expect((await sync(staff, [bad])).json.results[0]).toMatchObject({ reason: 'invalid' });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_ops WHERE op_id = ?')
      .bind(bad.opId)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('never reveals another device’s op result for a reused opId', async () => {
    const p = newPatient(doctor);
    await sync(doctor, [p]);
    const copy = { ...newPatient(staff), opId: p.opId };
    const { json } = await sync(staff, [copy]);
    expect(json.results[0]).toEqual({ opId: p.opId, outcome: 'rejected', reason: 'invalid' });
  });

  it(`holds back new ops from a device past ${DEVICE_DAILY_OPS} ops in 24 h, but keeps it up to date`, async () => {
    const now = Date.now();
    const values = Array.from(
      { length: DEVICE_DAILY_OPS },
      () => `('${uuidv7()}', '${staff.deviceId}', '{}', ${now})`,
    );
    for (let i = 0; i < values.length; i += 400) {
      await env.DB.prepare(
        `INSERT INTO sync_ops (op_id, device_id, result, applied_at) VALUES ${values.slice(i, i + 400).join(',')}`,
      ).run();
    }
    const res = await sync(staff, [newPatient(staff)]);
    // New ops are held back (no answer), but the pull still comes through.
    expect(res.status).toBe(200);
    expect(res.json.results).toEqual([]);
    expect(res.json.retryOpsAfterMs).toBeGreaterThan(0);
    expect(res.json.changes.users?.length).toBe(2);
  });
});

// Each of these runs several rounds of simultaneous requests: allow for a loaded machine.
describe('POST /sync: concurrent devices', { timeout: 60_000 }, () => {
  it('applies a decision only to the row it was made on (no revived cancel, no stale transition)', async () => {
    const pid = newPatient(doctor);
    const b = newBooking(doctor, pid.entityId, nextMonday(10));
    await sync(doctor, [pid, b]);
    for (let i = 0; i < 5; i++) {
      const [arrived, cancel] = await Promise.all([
        sync(staff, [op(staff, 'bookings', 'update', { status: 'arrived' }, { entityId: b.entityId })]),
        sync(doctor, [
          op(
            doctor,
            'bookings',
            'update',
            { status: 'cancelled', cancelReason: 'sick' },
            { entityId: b.entityId },
          ),
        ]),
      ]);
      const outcomes = [arrived.json.results[0], cancel.json.results[0]];
      const final = await bookingStatus(b.entityId);
      // Exactly one wins, the other is refused against the row it actually meets.
      if (final.status === 'arrived') {
        expect(outcomes[0]?.outcome).toBe('applied');
        expect(outcomes[1]).toMatchObject({ outcome: 'rejected', reason: 'invalid_transition' });
      } else {
        expect(final.status).toBe('cancelled');
        expect(outcomes[1]?.outcome).toBe('applied');
        expect(outcomes[0]).toMatchObject({ outcome: 'rejected', reason: 'invalid_transition' });
      }
      // Reset for the next round.
      await env.DB.prepare("UPDATE bookings SET status = 'approved', cancel_reason = NULL WHERE id = ?")
        .bind(b.entityId)
        .run();
    }
  });

  it('never writes a booking into a block that appeared while it was being decided', async () => {
    const p = newPatient(staff);
    await sync(staff, [p]);
    for (let i = 0; i < 5; i++) {
      const start = nextMonday(9 + i);
      const block = op(doctor, 'blocks', 'create', {
        startAt: start,
        endAt: start + 3_600_000,
        reason: null,
      });
      const booking = newBooking(staff, p.entityId, start);
      await Promise.all([sync(doctor, [block]), sync(staff, [booking])]);
      const row = await env.DB.prepare('SELECT version FROM bookings WHERE id = ?')
        .bind(booking.entityId)
        .first<{ version: number }>();
      const blockRow = await env.DB.prepare('SELECT version FROM blocks WHERE id = ?')
        .bind(block.entityId)
        .first<{ version: number }>();
      // Never lost, and never an active booking written inside the block: either it landed
      // first (the block came later), or it was decided after the block and kept as needs_fixing.
      expect(row).not.toBeNull();
      const { status } = await bookingStatus(booking.entityId);
      if (row!.version > blockRow!.version) expect(status).toBe('needs_fixing');
      else expect(CLASH_STATUSES as readonly string[]).toContain(status);
    }
  });

  it('never writes a booking for a patient deleted while it was being decided', async () => {
    for (let i = 0; i < 5; i++) {
      const p = newPatient(doctor);
      await sync(doctor, [p]);
      const del = op(doctor, 'patients', 'delete', {}, { entityId: p.entityId });
      const booking = newBooking(staff, p.entityId, nextMonday(9 + i));
      await Promise.all([sync(doctor, [del]), sync(staff, [booking])]);
      const row = await env.DB.prepare('SELECT version FROM bookings WHERE id = ?')
        .bind(booking.entityId)
        .first<{ version: number }>();
      const patient = await env.DB.prepare('SELECT version FROM patients WHERE id = ?')
        .bind(p.entityId)
        .first<{ version: number }>();
      if (row) expect(row.version).toBeLessThan(patient!.version);
    }
  });

  it('lets two Doctor devices create the same day rule at once (upsert, last wins)', async () => {
    const date = localDateOf(nextMonday(10));
    const second = await setupSecondDoctorDevice();
    const rule = (closeAt: number) => ({
      openAt: 540,
      closeAt,
      lunchStart: null,
      lunchEnd: null,
      closed: false,
      note: null,
    });
    const [a, b] = await Promise.all([
      sync(doctor, [op(doctor, 'dayRules', 'create', rule(690), { entityId: date })]),
      sync(second, [op(second, 'dayRules', 'create', rule(720), { entityId: date })]),
    ]);
    expect([a.json.results[0]?.outcome, b.json.results[0]?.outcome]).toEqual(['applied', 'applied']);
  });
});

async function setupSecondDoctorDevice(): Promise<EnrolResponse> {
  const res = await call('POST', '/enrol', {
    body: { name: 'Dr. Selam', pin: '258014', deviceLabel: 'Tablet' },
  });
  return res.json as unknown as EnrolResponse;
}

describe('POST /sync: permissions (PRD §9)', () => {
  const procedure = {
    nameAm: 'ጽዳት',
    nameEn: 'Cleaning',
    code: 'C',
    durationMin: 30,
    color: '#22aa66',
    active: true,
    sort: 0,
  };

  it('lets only the Doctor change clinic configuration', async () => {
    const forStaff = await sync(staff, [op(staff, 'procedures', 'create', procedure)]);
    expect(forStaff.json.results[0]).toMatchObject({ outcome: 'rejected', reason: 'forbidden' });
    const forDoctor = await sync(doctor, [op(doctor, 'procedures', 'create', procedure)]);
    expect(forDoctor.json.results[0]?.outcome).toBe('applied');
  });

  it('refuses a duplicate procedure code', async () => {
    const { json } = await sync(doctor, [
      op(doctor, 'procedures', 'create', procedure),
      op(doctor, 'procedures', 'create', procedure),
    ]);
    expect(json.results[1]).toMatchObject({ outcome: 'rejected', reason: 'code_taken' });
  });

  it('lets only the Doctor delete patients', async () => {
    const p = newPatient(staff);
    await sync(staff, [p]);
    const del = () => op(staff, 'patients', 'delete', {}, { entityId: p.entityId });
    expect((await sync(staff, [del()])).json.results[0]).toMatchObject({ reason: 'forbidden' });
    const asDoctor = op(doctor, 'patients', 'delete', {}, { entityId: p.entityId });
    expect((await sync(doctor, [asDoctor])).json.results[0]?.outcome).toBe('applied');
  });

  it('upserts settings and day rules by key', async () => {
    const date = localDateOf(nextMonday(10));
    const rule = {
      openAt: 540,
      closeAt: 690,
      lunchStart: null,
      lunchEnd: null,
      closed: false,
      note: 'leaves at 11:30',
    };
    const { json } = await sync(doctor, [
      op(doctor, 'dayRules', 'create', rule, { entityId: date }),
      op(doctor, 'dayRules', 'create', { ...rule, closeAt: 720 }, { entityId: date }),
      op(doctor, 'settings', 'update', { unspecifiedDurationMin: 45 }, { entityId: 'settings' }),
    ]);
    expect(json.results.map((r) => r.outcome)).toEqual(['applied', 'applied', 'applied']);
    expect(json.changes.dayRules).toEqual([expect.objectContaining({ date, closeAt: 720 })]);
    expect(json.changes.settings?.[0]).toMatchObject({
      unspecifiedDurationMin: 45,
      weeklyHours: expect.any(Array),
    });
  });
});

describe('POST /sync: bookings (PRD §6, §7.4, §10)', () => {
  async function patient(as = staff) {
    const p = newPatient(as);
    await sync(as, [p]);
    return p.entityId;
  }

  it('sends Staff bookings for approval and auto-approves the Doctor’s', async () => {
    const pid = await patient();
    const s = newBooking(staff, pid, nextMonday(9));
    const d = newBooking(doctor, pid, nextMonday(14));
    await sync(staff, [s]);
    await sync(doctor, [d]);
    expect((await bookingStatus(s.entityId)).status).toBe('pending_approval');
    expect((await bookingStatus(d.entityId)).status).toBe('approved');
  });

  it('stores an overlapping booking as a clash with the winner', async () => {
    const pid = await patient();
    const first = newBooking(staff, pid, nextMonday(10));
    const second = newBooking(staff, pid, nextMonday(10, 30), 30);
    const { json } = await sync(staff, [first, second]);
    expect(json.results[1]).toEqual({
      opId: second.opId,
      outcome: 'clash',
      version: expect.any(Number),
      winner: first.entityId,
    });
    expect(await bookingStatus(second.entityId)).toEqual({ status: 'clash', clash_with_id: first.entityId });
  });

  it('lets back-to-back bookings share an edge', async () => {
    const pid = await patient();
    const { json } = await sync(staff, [
      newBooking(staff, pid, nextMonday(10)),
      newBooking(staff, pid, nextMonday(11)),
    ]);
    expect(json.results.map((r) => r.outcome)).toEqual(['applied', 'applied']);
  });

  it('picks exactly one winner when two devices book the same slot at once', async () => {
    const pid = await patient();
    for (let i = 0; i < 5; i++) {
      const start = nextMonday(9 + i);
      const [a, b] = await Promise.all([
        sync(staff, [newBooking(staff, pid, start)]),
        sync(doctor, [newBooking(doctor, pid, start)]),
      ]);
      const outcomes = [a.json.results[0]!.outcome, b.json.results[0]!.outcome].sort();
      expect(outcomes).toEqual(['applied', 'clash']);
    }
  });

  it('ignores cancelled bookings in the clash check', async () => {
    const pid = await patient();
    const first = newBooking(staff, pid, nextMonday(10));
    await sync(staff, [first]);
    await sync(staff, [
      op(
        staff,
        'bookings',
        'update',
        { status: 'cancelled', cancelReason: 'sick' },
        { entityId: first.entityId },
      ),
    ]);
    const { json } = await sync(staff, [newBooking(staff, pid, nextMonday(10))]);
    expect(json.results[0]?.outcome).toBe('applied');
  });

  it.each([
    ['closed_day', () => nextMonday(10) - 24 * 3_600_000, 60], // Sunday
    ['before_open', () => nextMonday(8), 60],
    ['after_close', () => nextMonday(17, 30), 60],
  ])(
    'keeps a booking that breaks a hard clinic-hours limit as needs_fixing: %s',
    async (reason, start, duration) => {
      const pid = await patient();
      const b = newBooking(staff, pid, start(), duration);
      const { json } = await sync(staff, [b]);
      expect(json.results[0]).toEqual({
        opId: b.opId,
        outcome: 'needs_fixing',
        version: expect.any(Number),
        reason,
      });
      expect(await bookingStatus(b.entityId)).toEqual({ status: 'needs_fixing', clash_with_id: null });
    },
  );

  it('refuses a move into a time outside the hours; the booking keeps its confirmed time', async () => {
    const pid = await patient();
    const b = newBooking(doctor, pid, nextMonday(10));
    await sync(doctor, [b]);
    await sync(doctor, [
      op(doctor, 'blocks', 'create', { startAt: nextMonday(14), endAt: nextMonday(15), reason: null }),
    ]);
    const move = op(staff, 'bookings', 'update', { startAt: nextMonday(14) }, { entityId: b.entityId });
    expect((await sync(staff, [move])).json.results[0]).toMatchObject({
      outcome: 'rejected',
      reason: 'in_block',
    });
    const row = await env.DB.prepare('SELECT status, start_at FROM bookings WHERE id = ?')
      .bind(b.entityId)
      .first();
    expect(row).toEqual({ status: 'approved', start_at: nextMonday(10) });
  });

  it('re-checks a needs_fixing booking in place once the hours allow it again', async () => {
    const pid = await patient();
    const date = localDateOf(nextMonday(10));
    const close = op(
      doctor,
      'dayRules',
      'create',
      {
        openAt: null,
        closeAt: null,
        lunchStart: null,
        lunchEnd: null,
        closed: true,
        note: null,
      },
      { entityId: date },
    );
    await sync(doctor, [close]);
    const b = newBooking(staff, pid, nextMonday(10));
    expect((await sync(staff, [b])).json.results[0]).toMatchObject({
      outcome: 'needs_fixing',
      reason: 'closed_day',
    });
    // Still closed: the same time is refused and it stays needs_fixing.
    const same = () => op(staff, 'bookings', 'update', { startAt: nextMonday(10) }, { entityId: b.entityId });
    expect((await sync(staff, [same()])).json.results[0]).toMatchObject({
      outcome: 'rejected',
      reason: 'closed_day',
    });
    expect((await bookingStatus(b.entityId)).status).toBe('needs_fixing');
    // The Doctor opens the day again: the same time now passes.
    await sync(doctor, [op(doctor, 'dayRules', 'delete', {}, { entityId: date })]);
    expect((await sync(staff, [same()])).json.results[0]?.outcome).toBe('applied');
    expect((await bookingStatus(b.entityId)).status).toBe('pending_approval');
  });

  it('lets the Doctor fix (→ approved) or anyone cancel a needs_fixing booking, but not approve it', async () => {
    const pid = await patient();
    const one = newBooking(staff, pid, nextMonday(17, 30), 60);
    const two = newBooking(staff, pid, nextMonday(17, 30), 60);
    await sync(staff, [one, two]);
    const approve = op(doctor, 'bookings', 'update', { status: 'approved' }, { entityId: one.entityId });
    expect((await sync(doctor, [approve])).json.results[0]).toMatchObject({ reason: 'invalid_transition' });
    const fix = op(doctor, 'bookings', 'update', { startAt: nextMonday(9) }, { entityId: one.entityId });
    expect((await sync(doctor, [fix])).json.results[0]?.outcome).toBe('applied');
    expect((await bookingStatus(one.entityId)).status).toBe('approved');
    const cancel = op(
      staff,
      'bookings',
      'update',
      { status: 'cancelled', cancelReason: 'patient will call back' },
      { entityId: two.entityId },
    );
    expect((await sync(staff, [cancel])).json.results[0]?.outcome).toBe('applied');
  });

  it('returns the stored needs_fixing result for a re-sent op', async () => {
    const pid = await patient();
    const b = newBooking(staff, pid, nextMonday(17, 30), 60);
    const first = await sync(staff, [b]);
    expect((await sync(staff, [b])).json.results).toEqual(first.json.results);
  });

  it('does not let a needs_fixing booking block the slot, and fixes it when moved', async () => {
    const pid = await patient();
    const bad = newBooking(staff, pid, nextMonday(17, 30), 60); // ends after closing
    await sync(staff, [bad]);
    const other = newBooking(staff, pid, nextMonday(17, 30), 30); // fits, same start
    expect((await sync(staff, [other])).json.results[0]?.outcome).toBe('applied');
    const move = op(staff, 'bookings', 'update', { startAt: nextMonday(14) }, { entityId: bad.entityId });
    expect((await sync(staff, [move])).json.results[0]?.outcome).toBe('applied');
    expect((await bookingStatus(bad.entityId)).status).toBe('pending_approval');
  });

  it('keeps a booking inside a Doctor’s block as needs_fixing, but allows lunch', async () => {
    const pid = await patient();
    await sync(doctor, [
      op(doctor, 'blocks', 'create', { startAt: nextMonday(15), endAt: nextMonday(16), reason: 'meeting' }),
    ]);
    const { json } = await sync(staff, [
      newBooking(staff, pid, nextMonday(15, 30), 30),
      newBooking(staff, pid, nextMonday(12), 60),
    ]);
    expect(json.results.map((r) => (r.outcome === 'needs_fixing' ? r.reason : r.outcome))).toEqual([
      'in_block',
      'applied',
    ]);
  });

  it('refuses a booking for an unknown patient', async () => {
    const { json } = await sync(staff, [newBooking(staff, uuidv7(), nextMonday(10))]);
    expect(json.results[0]).toMatchObject({ outcome: 'rejected', reason: 'patient_not_found' });
  });

  it('enforces the lifecycle: approve is Doctor-only, cancel needs a reason, no-show waits', async () => {
    const pid = await patient();
    const b = newBooking(staff, pid, nextMonday(10));
    await sync(staff, [b]);
    const update = (as: EnrolResponse, fields: Record<string, unknown>) =>
      op(as, 'bookings', 'update', fields, { entityId: b.entityId });

    const results = async (as: EnrolResponse, fields: Record<string, unknown>) =>
      (await sync(as, [update(as, fields)])).json.results[0] as OpResult;

    expect(await results(staff, { status: 'approved' })).toMatchObject({ reason: 'forbidden' });
    expect(await results(staff, { status: 'cancelled' })).toMatchObject({ reason: 'reason_required' });
    expect(await results(doctor, { status: 'approved' })).toMatchObject({ outcome: 'applied' });
    expect(await results(staff, { status: 'no_show' })).toMatchObject({ reason: 'too_early' });
    expect(await results(staff, { status: 'done' })).toMatchObject({ reason: 'invalid_transition' });
    const approved = await env.DB.prepare('SELECT approved_by FROM bookings WHERE id = ?')
      .bind(b.entityId)
      .first<{ approved_by: string }>();
    expect(approved?.approved_by).toBe(doctor.user.id);
  });

  it('sends an approved booking moved by Staff back for approval; a note change keeps it approved', async () => {
    const pid = await patient();
    const b = newBooking(doctor, pid, nextMonday(10));
    await sync(doctor, [b]);
    await sync(staff, [op(staff, 'bookings', 'update', { note: 'bring x-ray' }, { entityId: b.entityId })]);
    expect((await bookingStatus(b.entityId)).status).toBe('approved');
    await sync(staff, [
      op(staff, 'bookings', 'update', { startAt: nextMonday(11) }, { entityId: b.entityId }),
    ]);
    expect((await bookingStatus(b.entityId)).status).toBe('pending_approval');
  });

  it('fixes a clash when the booking is moved to a free slot', async () => {
    const pid = await patient();
    const first = newBooking(staff, pid, nextMonday(10));
    const second = newBooking(staff, pid, nextMonday(10));
    await sync(staff, [first, second]);
    const move = op(staff, 'bookings', 'update', { startAt: nextMonday(14) }, { entityId: second.entityId });
    const { json } = await sync(staff, [move]);
    expect(json.results[0]?.outcome).toBe('applied');
    expect(await bookingStatus(second.entityId)).toEqual({ status: 'pending_approval', clash_with_id: null });
  });
});

describe('POST /sync: pull', () => {
  it('returns users as names and roles only', async () => {
    const { json } = await sync(staff, []);
    expect(json.changes.users?.map((u) => Object.keys(u).sort())).toEqual([
      ['deletedAt', 'disabledAt', 'id', 'name', 'role', 'updatedAt', 'updatedBy', 'version'],
      ['deletedAt', 'disabledAt', 'id', 'name', 'role', 'updatedAt', 'updatedBy', 'version'],
    ]);
  });

  it('returns nothing new for an up-to-date cursor', async () => {
    const first = await sync(staff, []);
    const again = await sync(staff, [], first.json.newCursor);
    expect(again.json).toEqual({ results: [], changes: {}, newCursor: first.json.newCursor, more: false });
  });

  it('pages through changes in version order without gaps or repeats', async () => {
    await sync(
      staff,
      Array.from({ length: 7 }, () => newPatient(staff)),
    );
    const db = getDb(env.DB);
    const seen: number[] = [];
    let cursor = 0;
    for (let more = true; more;) {
      const page = await pull(db, cursor, Date.now(), { pageSize: 3 });
      const versions = Object.values(page.changes).flatMap((rows) => rows.map((r) => r.version));
      expect(versions.length).toBeLessThanOrEqual(3);
      seen.push(...versions);
      ({ more } = page);
      cursor = page.newCursor;
    }
    const all = await env.DB.prepare(
      'SELECT version FROM patients UNION ALL SELECT version FROM users ORDER BY version',
    ).all<{ version: number }>();
    expect(seen.sort((a, b) => a - b)).toEqual(all.results.map((r) => r.version));
  });

  it('leaves out bookings older than the 30-day window on first install (PRD §7.1)', async () => {
    const p = newPatient(staff);
    await sync(staff, [p]);
    const old = Date.now() - 40 * 86_400_000;
    await env.DB.prepare(
      `INSERT INTO bookings (id, patient_id, start_at, duration_min, status, source, created_by, version, updated_at)
       VALUES (?, ?, ?, 60, 'done', 'app', ?, 999999, ?)`,
    )
      .bind(uuidv7(), p.entityId, old, staff.user.id, Date.now())
      .run();
    const { json } = await sync(staff, [], 0, true);
    expect(json.changes.bookings ?? []).toEqual([]);
    // A pull from cursor 0 is a first fill even if the device says otherwise.
    expect((await sync(staff, [], 0, false)).json.changes.bookings ?? []).toEqual([]);
  });

  it('after the first fill, sends changes to old bookings too, so no device keeps a stale copy', async () => {
    const p = newPatient(staff);
    await sync(staff, [p]);
    const id = uuidv7();
    await env.DB.prepare(
      `INSERT INTO bookings (id, patient_id, start_at, duration_min, status, source, created_by, version, updated_at)
       VALUES (?, ?, ?, 60, 'done', 'app', ?, 999999, ?)`,
    )
      .bind(id, p.entityId, Date.now() - 40 * 86_400_000, staff.user.id, Date.now())
      .run();
    const { json } = await sync(staff, [], 1);
    expect(json.changes.bookings?.map((b) => b.id)).toEqual([id]);
  });

  it('keeps a typical day’s sync well under the 20 KB budget (PRD §7.8)', async () => {
    // A busy day: 40 new patients and 40 bookings arriving on another device.
    const ops: SyncOp[] = [];
    for (let i = 0; i < 40; i++) {
      const p = newPatient(staff, `ታካሚ ቁጥር ${i}`);
      ops.push(
        p,
        newBooking(
          staff,
          p.entityId,
          nextMonday(9) + (i % 8) * 3_600_000 + Math.floor(i / 8) * 7 * 86_400_000,
        ),
      );
    }
    await sync(staff, ops);
    const res = await call('POST', '/sync', {
      token: doctor.token,
      body: { deviceId: doctor.deviceId, cursor: 0, ops: [] },
    });
    const raw = new TextEncoder().encode(JSON.stringify(res.json));
    const gzipped = await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer();
    expect(gzipped.byteLength).toBeLessThan(20 * 1024);
  });
});

describe('query plans (PRD §19: no full-table scans on hot paths)', () => {
  const plan = async (sqlText: string, ...params: unknown[]) =>
    (
      await env.DB.prepare(`EXPLAIN QUERY PLAN ${sqlText}`)
        .bind(...params)
        .all<{ detail: string }>()
    ).results
      .map((r) => r.detail)
      .join('\n');

  it('uses indexes for the clash check', async () => {
    const detail = await plan(
      `SELECT o.id FROM bookings o WHERE o.status IN ('pending_approval','approved','arrived')
        AND o.start_at < ? AND o.start_at > ? AND o.start_at + o.duration_min * 60000 > ? AND o.id <> ?
        AND o.deleted_at IS NULL ORDER BY o.version LIMIT 1`,
      2,
      1,
      1,
      'x',
    );
    expect(detail).toMatch(/USING INDEX/);
    expect(detail).not.toMatch(/SCAN o(?! USING)/);
  });

  it.each(['patients', 'bookings', 'procedures', 'day_rules', 'blocks', 'holidays', 'users'])(
    'pulls %s by the version index',
    async (table) => {
      const detail = await plan(`SELECT * FROM ${table} WHERE version > ? ORDER BY version LIMIT 501`, 0);
      expect(detail).toMatch(/USING INDEX/);
      expect(detail).not.toMatch(/SCAN \w+$/m);
    },
  );
});

describe('POST /sync: call list outcomes (PRD §8 item 8, ADR 0008)', () => {
  async function staffBooking() {
    const p = newPatient(staff);
    const b = newBooking(staff, p.entityId, nextMonday(10));
    await sync(staff, [p, b]);
    return b.entityId;
  }
  const callOp = (as: EnrolResponse, id: string, fields: Record<string, unknown>) =>
    op(as, 'bookings', 'update', fields, { entityId: id });
  const row = (id: string) =>
    env.DB.prepare(
      'SELECT status, patient_confirmed_at, call_handled_at, call_handled_by, call_tried_at FROM bookings WHERE id = ?',
    )
      .bind(id)
      .first<Record<string, unknown>>();

  it('records a confirmed call: patient confirmed and handled, by the caller', async () => {
    const id = await staffBooking();
    const { json } = await sync(staff, [callOp(staff, id, { call: 'confirmed', callFor: nextMonday(10) })]);
    expect(json.results[0]).toMatchObject({ outcome: 'applied' });
    expect(await row(id)).toMatchObject({
      status: 'pending_approval',
      patient_confirmed_at: expect.any(Number),
      call_handled_at: expect.any(Number),
      call_handled_by: staff.user.id,
      call_tried_at: null,
    });
    const pulled = json.changes.bookings?.find((b) => b.id === id);
    expect(pulled).toMatchObject({ callHandledBy: staff.user.id, callTriedAt: null });
  });

  it('records an unanswered call without handling the row', async () => {
    const id = await staffBooking();
    await sync(staff, [callOp(staff, id, { call: 'no_answer', callFor: nextMonday(10) })]);
    expect(await row(id)).toMatchObject({
      patient_confirmed_at: null,
      call_handled_at: null,
      call_tried_at: expect.any(Number),
    });
  });

  it('refuses an outcome sent with another change, or on a booking no longer coming up', async () => {
    const id = await staffBooking();
    const mixed = await sync(staff, [
      callOp(staff, id, { call: 'handled', callFor: nextMonday(10), note: 'x' }),
    ]);
    expect(mixed.json.results[0]).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
    await sync(staff, [callOp(staff, id, { status: 'cancelled', cancelReason: 'ill' })]);
    const late = await sync(staff, [callOp(staff, id, { call: 'handled', callFor: nextMonday(10) })]);
    expect(late.json.results[0]).toMatchObject({ outcome: 'rejected', reason: 'invalid_transition' });
  });

  it('refuses a call made about a time the booking no longer has', async () => {
    const id = await staffBooking();
    // Another phone moves it to 11:00 first; the call was about 10:00.
    await sync(staff, [callOp(staff, id, { startAt: nextMonday(11) })]);
    const late = await sync(staff, [callOp(staff, id, { call: 'confirmed', callFor: nextMonday(10) })]);
    expect(late.json.results[0]).toMatchObject({ outcome: 'rejected', reason: 'call_outdated' });
    expect(await row(id)).toMatchObject({ patient_confirmed_at: null, call_handled_at: null });
  });

  it('refuses a call outcome without the time it was about', async () => {
    const id = await staffBooking();
    const { json } = await sync(staff, [callOp(staff, id, { call: 'handled' })]);
    expect(json.results[0]).toMatchObject({ outcome: 'rejected', reason: 'invalid' });
  });

  it('audits the outcome by name', async () => {
    const id = await staffBooking();
    await sync(staff, [callOp(staff, id, { call: 'no_answer', callFor: nextMonday(10) })]);
    const audit = await env.DB.prepare(
      "SELECT action FROM audit_log WHERE entity_id = ? AND action LIKE 'call:%'",
    )
      .bind(id)
      .first<{ action: string }>();
    expect(audit?.action).toBe('call:no_answer');
  });

  it('keeps the confirmation when only the length changes', async () => {
    const id = await staffBooking();
    await sync(staff, [callOp(staff, id, { call: 'confirmed', callFor: nextMonday(10) })]);
    await sync(staff, [callOp(staff, id, { durationMin: 90 })]);
    expect(await row(id)).toMatchObject({ patient_confirmed_at: expect.any(Number) });
  });

  it('clears the confirmation and call marks when the booking moves', async () => {
    const id = await staffBooking();
    await sync(staff, [callOp(staff, id, { call: 'confirmed', callFor: nextMonday(10) })]);
    await sync(staff, [callOp(staff, id, { startAt: nextMonday(11) })]);
    expect(await row(id)).toMatchObject({
      patient_confirmed_at: null,
      call_handled_at: null,
      call_handled_by: null,
      call_tried_at: null,
    });
  });
});
