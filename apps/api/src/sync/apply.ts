/**
 * The push half of `/sync` (PRD §7.4, §9, §10; docs/adr/0006-sync-protocol.md).
 *
 * An op is decided from one read batch (the row, plus what a booking needs), then written in one
 * write batch with its new version, its `audit_log` row and its `sync_ops` result. The write is
 * **guarded by the version that was read**: if another device changed the row in between, nothing
 * of this op is written and it is decided again from the new row. So a decision is never applied
 * to a row it did not see (no revived cancels, no second winner).
 *
 * Queries per op are bounded (`MAX_QUERIES_PER_OP`) so the route can stay inside the D1
 * per-invocation limit.
 */
import { type SQL, and, count, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { bookings, patients, procedures, syncOps, syncSeq } from '@yegna/db';
import {
  type CallOutcome,
  type OpResult,
  type Role,
  type SyncOp,
  type SyncRejectReason,
  type WriteEntity,
  checkStatusChange,
  parseOpFields,
  statusAfterReschedule,
  statusOnCreate,
  uuidv7,
} from '@yegna/shared';
import { type BookingError, DEFAULT_UNSPECIFIED_DURATION_MIN, DEFAULT_WEEKLY_HOURS } from '@yegna/time';
import {
  CURRENT_VERSION,
  type Db,
  type Statement,
  isUniqueViolation,
  rawBatch,
  withVersion,
} from '../lib/db.ts';
import type { Session } from '../lib/http.ts';
import {
  bookingDependenciesUnchanged,
  clashAwareResult,
  clashStatement,
  clinicHoursError,
  hoursError,
  hoursQueries,
} from './bookings.ts';
import { KEY_COLUMNS, TABLES } from './tables.ts';

export interface OpContext {
  db: Db;
  session: Session;
  now: number;
}

/**
 * Worst case per op: (read batch + extra hours read + write batch) × 2 attempts, then storing a
 * refusal found at the last write + reading back a concurrent copy's result.
 */
export const MAX_QUERIES_PER_OP = 8;
const ATTEMPTS = 2;
/** D1 allows 100 bound parameters per statement. */
const MAX_IDS_PER_QUERY = 90;

type Row = Record<string, unknown>;

type Decision =
  | { reject: SyncRejectReason; redact?: boolean }
  | {
      statements: Statement[];
      action: string;
      diff: Record<string, unknown>;
      /** SQL producing the stored result; defaults to `applied` with the new version. */
      result?: SQL;
    };

/** Clinic configuration: the Doctor only (PRD §9). */
const DOCTOR_ONLY: ReadonlySet<WriteEntity> = new Set([
  'procedures',
  'dayRules',
  'blocks',
  'holidays',
  'settings',
]);
/** Keyed by something other than a fresh id: a create on an existing key updates it. */
const UPSERT: ReadonlySet<WriteEntity> = new Set(['dayRules', 'settings']);
/** Table and key column names (constants, safe to inline) for the version guard and audit. */
const SQL_NAMES: Record<WriteEntity, { table: string; key: string }> = {
  patients: { table: 'patients', key: 'id' },
  bookings: { table: 'bookings', key: 'id' },
  procedures: { table: 'procedures', key: 'id' },
  dayRules: { table: 'day_rules', key: 'date' },
  blocks: { table: 'blocks', key: 'id' },
  holidays: { table: 'holidays', key: 'id' },
  settings: { table: 'settings', key: 'id' },
};

const SETTINGS_DEFAULTS = {
  weeklyHours: DEFAULT_WEEKLY_HOURS,
  unspecifiedDurationMin: DEFAULT_UNSPECIFIED_DURATION_MIN,
  patientReminderAt: 18 * 60,
  doctorSummaryAt: 19 * 60,
  defaultTemplate: null,
};

const reject = (reason: SyncRejectReason): Decision => ({ reject: reason });

/**
 * What a deleted patient's row keeps: nothing that identifies them. The phone becomes free for a
 * new patient (the unique index covers live patients only, migration 0003).
 */
const ERASED_PATIENT = { name: '', phoneE164: '', note: null, telegramChatId: null, telegramLinkedAt: null };

/**
 * Everything else that could identify a deleted patient (ADR 0007): their bookings' notes and cancel
 * reasons, and the values in the audit history of the patient and those bookings, including refused
 * bookings made for them. Runs after the delete in the same batch, only if that delete landed (the
 * row carries this batch's version). Bookings touched get the new version, so devices pull them.
 */
function erasePatientTraces(patientId: string, ctx: OpContext) {
  const landed = sql`EXISTS (SELECT 1 FROM patients
    WHERE id = ${patientId} AND deleted_at IS NOT NULL AND version = ${CURRENT_VERSION})`;
  const freeText = sql`json_remove(diff, '$.note', '$.cancelReason', '$.fields.note', '$.fields.cancelReason')`;
  return [
    sql`UPDATE audit_log SET diff = NULL
      WHERE entity = 'patients' AND entity_id = ${patientId} AND ${landed}`,
    sql`UPDATE audit_log SET diff = ${freeText}
      WHERE entity = 'bookings' AND diff IS NOT NULL AND ${landed}
        AND (entity_id IN (SELECT id FROM bookings WHERE patient_id = ${patientId})
          OR json_extract(diff, '$.fields.patientId') = ${patientId})`,
    sql`UPDATE bookings
      SET note = NULL, cancel_reason = NULL, version = ${CURRENT_VERSION},
          updated_at = ${ctx.now}, updated_by = ${ctx.session.user.id}
      WHERE patient_id = ${patientId} AND (note IS NOT NULL OR cancel_reason IS NOT NULL) AND ${landed}`,
  ];
}

/**
 * Stored results of ops this device already sent, for all of `opIds` in one query, plus how many
 * ops the device sent in the last 24 h (for the daily budget).
 */
export async function prefetch(
  db: Db,
  deviceId: string,
  opIds: string[],
  since: number,
): Promise<{ stored: Map<string, OpResult>; opsSince: number }> {
  const chunks: string[][] = [];
  for (let i = 0; i < opIds.length; i += MAX_IDS_PER_QUERY)
    chunks.push(opIds.slice(i, i + MAX_IDS_PER_QUERY));
  const [counted, ...found] = await db.batch([
    // A query builder, not raw `sql`: Drizzle's db.batch can't run raw SQL with parameters.
    db
      .select({ n: count() })
      .from(syncOps)
      .where(and(eq(syncOps.deviceId, deviceId), gt(syncOps.appliedAt, since))),
    ...chunks.map((ids) =>
      db
        .select({ opId: syncOps.opId, result: syncOps.result })
        .from(syncOps)
        .where(and(eq(syncOps.deviceId, deviceId), inArray(syncOps.opId, ids))),
    ),
  ] as never as [never]);
  const stored = new Map<string, OpResult>();
  for (const rows of found as unknown as { opId: string; result: string }[][]) {
    for (const r of rows) stored.set(r.opId, JSON.parse(r.result) as OpResult);
  }
  return { stored, opsSince: (counted as unknown as { n: number }[])[0]?.n ?? 0 };
}

/**
 * Applies one op not applied before. Returns null if it kept losing races; it is then left
 * unanswered and the device sends it again in its next sync.
 */
export async function applyOp(ctx: OpContext, op: SyncOp): Promise<OpResult | null> {
  const { role, id: userId } = ctx.session.user;
  // A device acts for the one user it was enrolled by.
  if (op.userId !== userId) return storeRejection(ctx, op, 'forbidden', null);
  const fields = parseOpFields(op.entity, op.kind, op.entityId, op.fields);
  // Invalid ops are refused but not stored: the answer follows from the op alone, so a re-send
  // gets it again without costing a write (PRD §19).
  if (!fields) return { opId: op.opId, outcome: 'rejected', reason: 'invalid' };
  if (DOCTOR_ONLY.has(op.entity) && role !== 'doctor') return storeRejection(ctx, op, 'forbidden', fields);
  if (op.entity === 'patients' && op.kind === 'delete' && role !== 'doctor') {
    return storeRejection(ctx, op, 'forbidden', fields);
  }

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const reads = await readContext(ctx.db, op, fields);
    const decision =
      op.entity === 'bookings'
        ? await decideBooking(ctx, op, fields, reads, role)
        : decideRow(ctx, op, fields, reads.current);
    if ('reject' in decision) return storeRejection(ctx, op, decision.reject, fields, decision.redact);
    const result = await commit(ctx, op, fields, decision);
    if (result !== 'lost_race') return result;
  }
  return null;
}

interface Reads {
  current: Row | undefined;
  /** `sync_seq` when the reads were taken; the write checks nothing it depended on changed since. */
  seenSeq: number;
  patientLive: boolean;
  procedureLive: boolean;
  /** For a booking update: whether the booking's patient is still live (not erased). */
  bookingPatientLive: boolean;
  /** Clinic-hours rows for `hoursFor`, read in the same batch when the time was known up front. */
  hours: { startAt: number; durationMin: number; rows: unknown[] } | null;
}

/** Everything an op's decision needs, in one batch (one query against the D1 limit). */
async function readContext(db: Db, op: SyncOp, fields: Row): Promise<Reads> {
  const queries: unknown[] = [
    db.select().from(TABLES[op.entity]).where(eq(KEY_COLUMNS[op.entity], op.entityId)),
    db.select({ value: syncSeq.value }).from(syncSeq),
  ];
  let patientAt = -1;
  let procedureAt = -1;
  let bookingPatientAt = -1;
  let hoursFor: { startAt: number; durationMin: number } | null = null;
  if (op.entity === 'bookings') {
    if (typeof fields.patientId === 'string') {
      patientAt = queries.push(liveQuery(db, 'patients', fields.patientId)) - 1;
    }
    if (typeof fields.procedureId === 'string') {
      procedureAt = queries.push(liveQuery(db, 'procedures', fields.procedureId)) - 1;
    }
    if (op.kind === 'update') {
      bookingPatientAt =
        queries.push(
          db
            .select({ id: patients.id })
            .from(bookings)
            .innerJoin(patients, eq(patients.id, bookings.patientId))
            .where(and(eq(bookings.id, op.entityId), isNull(patients.deletedAt))),
        ) - 1;
    }
    if (typeof fields.startAt === 'number' && typeof fields.durationMin === 'number') {
      hoursFor = { startAt: fields.startAt, durationMin: fields.durationMin };
      queries.push(...hoursQueries(db, hoursFor.startAt, hoursFor.durationMin));
    }
  }
  const results = (await db.batch(queries as never)) as unknown as Row[][];
  return {
    current: results[0]![0],
    seenSeq: (results[1]![0]?.value as number | undefined) ?? 0,
    patientLive: patientAt >= 0 && results[patientAt]!.length > 0,
    procedureLive: procedureAt >= 0 && results[procedureAt]!.length > 0,
    bookingPatientLive: bookingPatientAt >= 0 && results[bookingPatientAt]!.length > 0,
    hours: hoursFor ? { ...hoursFor, rows: results.slice(results.length - 4) } : null,
  };
}

function liveQuery(db: Db, entity: 'patients' | 'procedures', id: string) {
  const table = entity === 'patients' ? patients : procedures;
  return db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)));
}

/** Every entity except bookings: plain create / update / soft delete, last writer wins. */
function decideRow(ctx: OpContext, op: SyncOp, fields: Row, current: Row | undefined): Decision {
  const { db, now } = ctx;
  const table = TABLES[op.entity];
  const key = KEY_COLUMNS[op.entity];
  const stamp = { version: CURRENT_VERSION, updatedAt: now, updatedBy: ctx.session.user.id };
  const live = current !== undefined && current.deletedAt === null;
  const keyField = op.entity === 'dayRules' ? 'date' : 'id';
  // Write only if the row is still the one decided on.
  const unchanged = current
    ? and(eq(key, op.entityId), eq(table.version, current.version as number))
    : undefined;

  if (op.kind === 'delete') {
    if (!current) return reject('not_found');
    const erase = op.entity === 'patients';
    return {
      statements: [
        db
          .update(table)
          .set({
            ...stamp,
            deletedAt: (current.deletedAt as number | null) ?? now,
            // A deleted patient's details are erased, not hidden (decided 2026-11-10, ADR 0007).
            ...(erase ? ERASED_PATIENT : {}),
          } as never)
          .where(unchanged),
        // ...and so are their booking notes and the values kept in their audit history
        // (who changed what kind of thing, and when, stays).
        ...(erase ? erasePatientTraces(op.entityId, ctx) : []),
      ],
      action: 'delete',
      diff: staleMark(op, current),
    };
  }

  if (op.kind === 'create' && current && !UPSERT.has(op.entity)) return reject('exists');
  if (op.kind === 'update' && !live && !(op.entity === 'settings' && !current)) return reject('not_found');

  // The row as it will be after this op, for checks that span fields.
  const base = live ? current : op.entity === 'settings' ? SETTINGS_DEFAULTS : {};
  const merged = { ...base, ...fields };
  const invalid = checkMerged(op.entity, merged);
  if (invalid) return reject(invalid);

  if (!current) {
    const insert = db
      .insert(table)
      .values({ ...encode(op.entity, merged), [keyField]: op.entityId, ...stamp } as never);
    return {
      // Keyed entities upsert: two devices creating the same date at once both land (last wins).
      statements: [
        UPSERT.has(op.entity)
          ? insert.onConflictDoUpdate({
              target: key,
              set: { ...encode(op.entity, fields), ...stamp, deletedAt: null } as never,
            })
          : insert,
      ],
      action: 'create',
      diff: diffOf(undefined, fields),
    };
  }
  // Update, an upsert onto an existing key, or reviving a deleted day rule.
  return {
    statements: [
      db
        .update(table)
        .set({ ...encode(op.entity, live ? fields : merged), ...stamp, deletedAt: null } as never)
        .where(unchanged),
    ],
    action: live ? 'update' : 'create',
    diff: { ...diffOf(live ? current : undefined, fields), ...staleMark(op, current) },
  };
}

/** Rules that span fields, checked on the row as it will be after a partial update. */
function checkMerged(entity: WriteEntity, row: Row): SyncRejectReason | null {
  if (entity === 'blocks' && !((row.endAt as number) > (row.startAt as number))) return 'invalid';
  if (entity === 'dayRules') {
    const { openAt, closeAt, lunchStart, lunchEnd } = row as Record<string, number | null>;
    if (openAt != null && closeAt != null && openAt >= closeAt) return 'invalid';
    if (lunchStart != null && lunchEnd != null && lunchStart >= lunchEnd) return 'invalid';
  }
  return null;
}

function encode(entity: WriteEntity, fields: Row): Row {
  if (entity === 'settings' && fields.weeklyHours !== undefined) {
    return { ...fields, weeklyHours: JSON.stringify(fields.weeklyHours) };
  }
  return fields;
}

async function decideBooking(
  ctx: OpContext,
  op: SyncOp,
  fields: Row,
  reads: Reads,
  role: Role,
): Promise<Decision> {
  const { db, now } = ctx;
  const { current } = reads;
  const userId = ctx.session.user.id;
  const stamp = { version: CURRENT_VERSION, updatedAt: now, updatedBy: userId };
  const procedureId = fields.procedureId as string | null | undefined;
  if (procedureId && !reads.procedureLive) return reject('procedure_not_found');

  const hoursErrorAt = async (startAt: number, durationMin: number) =>
    reads.hours && reads.hours.startAt === startAt && reads.hours.durationMin === durationMin
      ? hoursError(reads.hours.rows, startAt, durationMin)
      : clinicHoursError(db, startAt, durationMin);

  if (op.kind === 'create') {
    if (current) return reject('exists');
    if (!reads.patientLive) return reject('patient_not_found');
    const startAt = fields.startAt as number;
    const durationMin = fields.durationMin as number;
    // Outside the clinic's hours as they are now (they changed after the device decided):
    // the booking is kept as needs_fixing instead of being refused (decided 2026-11-10, ADR 0007).
    const hours = await hoursErrorAt(startAt, durationMin);
    const status = hours ? 'needs_fixing' : statusOnCreate(role);
    const patientId = fields.patientId as string;
    const approved = status === 'approved';
    const deps = bookingDependenciesUnchanged({
      seenSeq: reads.seenSeq,
      startAt,
      durationMin,
      patientId,
      procedureId,
    });
    return {
      statements: [
        // Written only if what the decision read is still true (see bookingDependenciesUnchanged).
        sql`INSERT INTO bookings (id, patient_id, procedure_id, start_at, duration_min, note, status,
              approved_by, approved_at, source, created_by, version, updated_at, updated_by)
            SELECT ${op.entityId}, ${patientId}, ${procedureId ?? null}, ${startAt}, ${durationMin},
              ${(fields.note as string | null | undefined) ?? null}, ${status},
              ${approved ? userId : null}, ${approved ? now : null}, 'app', ${userId},
              ${CURRENT_VERSION}, ${now}, ${userId}
            WHERE ${deps}`,
        ...(hours ? [] : [clashStatement(op.entityId, startAt, durationMin)]),
      ],
      action: 'create',
      diff: diffOf(undefined, { ...fields, status }),
      result: hours ? needsFixingResult(op.opId, hours) : clashAwareResult(op.opId, op.entityId),
    };
  }

  // Bookings are never deleted (parseOpFields refuses it), so this is an update.
  if (!current || current.deletedAt !== null) return reject('not_found');
  // The booking's patient was erased (ADR 0007): status changes still work (e.g. cancel), but no
  // free text is stored on it again, and a refusal keeps no values.
  const erased = !reads.bookingPatientLive;
  const refuse = (reason: SyncRejectReason): Decision => ({ reject: reason, redact: erased });
  const set: Row = {};

  // A call-list outcome (ADR 0008), on a booking still coming up (sent alone, see sync.ts).
  const call = fields.call as CallOutcome | undefined;
  if (call !== undefined) {
    if (current.status !== 'pending_approval' && current.status !== 'approved') {
      return refuse('invalid_transition');
    }
    if (call === 'no_answer') set.callTriedAt = now;
    else Object.assign(set, { callHandledAt: now, callHandledBy: userId });
    if (call === 'confirmed') set.patientConfirmedAt = now;
  }

  const to = fields.status as string | undefined;
  if (to !== undefined) {
    const error = checkStatusChange({
      from: current.status as never,
      to: to as never,
      role,
      startAt: current.startAt as number,
      now,
      cancelReason: fields.cancelReason as string | null | undefined,
    });
    if (error) return refuse(error);
    set.status = to;
    if (to === 'approved') Object.assign(set, { approvedBy: userId, approvedAt: now });
    if (to === 'cancelled') set.cancelReason = erased ? null : fields.cancelReason;
  }

  const startAt = (fields.startAt as number | undefined) ?? (current.startAt as number);
  const durationMin = (fields.durationMin as number | undefined) ?? (current.durationMin as number);
  // A needs_fixing booking sent with its own time again is re-checked where it is (the hours may
  // have been restored); otherwise only a real change of time counts as a move.
  const recheck =
    current.status === 'needs_fixing' && (fields.startAt !== undefined || fields.durationMin !== undefined);
  const moved = recheck || startAt !== current.startAt || durationMin !== current.durationMin;
  if (moved) {
    const next = statusAfterReschedule(current.status as never, role);
    if (!next) return refuse('invalid_transition');
    // A move into a time outside the hours is refused: the booking keeps its confirmed time
    // (decided 2026-11-10, ADR 0007). Only new bookings are kept as needs_fixing.
    const hours = await hoursErrorAt(startAt, durationMin);
    if (hours) return refuse(hours);
    const stillApproved = next === 'approved' && current.status === 'approved';
    Object.assign(set, {
      startAt,
      durationMin,
      status: next,
      clashWithId: null,
      // A new time must be confirmed and called about again (ADR 0008).
      patientConfirmedAt: null,
      callHandledAt: null,
      callHandledBy: null,
      callTriedAt: null,
      approvedBy: next !== 'approved' ? null : stillApproved ? current.approvedBy : userId,
      approvedAt: next !== 'approved' ? null : stillApproved ? current.approvedAt : now,
    });
  }
  if (procedureId !== undefined) set.procedureId = procedureId;
  if (fields.note !== undefined) set.note = erased ? null : fields.note;

  return {
    statements: [
      db
        .update(bookings)
        .set({ ...set, ...stamp } as never)
        .where(
          and(
            eq(bookings.id, op.entityId),
            eq(bookings.version, current.version as number),
            // Decided with a live patient: lands only if the patient is still live, so text can't
            // be written after a delete that runs meanwhile (the op is then decided again).
            erased
              ? undefined
              : sql`EXISTS (SELECT 1 FROM patients WHERE id = ${bookings.patientId} AND deleted_at IS NULL)`,
            moved || procedureId
              ? bookingDependenciesUnchanged({ seenSeq: reads.seenSeq, startAt, durationMin, procedureId })
              : undefined,
          ),
        ),
      ...(moved ? [clashStatement(op.entityId, startAt, durationMin)] : []),
    ],
    action: to ? `status:${to}` : moved ? 'move' : 'update',
    diff: { ...diffOf(current, set), ...staleMark(op, current) },
    ...(moved ? { result: clashAwareResult(op.opId, op.entityId) } : {}),
  };
}

/** The stored result for a booking kept as needs_fixing. */
function needsFixingResult(opId: string, reason: BookingError) {
  return sql`json_object('opId', ${opId}, 'outcome', 'needs_fixing', 'version', ${CURRENT_VERSION}, 'reason', ${reason})`;
}

/** `{ field: [old, new] }` for the fields this op changes; `{ field: new }` on create. */
function diffOf(current: Row | undefined, fields: Row): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!current) diff[k] = v;
    else if (JSON.stringify(current[k]) !== JSON.stringify(v)) diff[k] = [current[k], v];
  }
  return diff;
}

/**
 * Last writer wins, but nothing is lost silently (PRD §7.4 step 3): when the device had not
 * seen the latest version, the audit row says so, next to the overwritten values.
 */
function staleMark(op: SyncOp, current: Row): Record<string, unknown> {
  return op.baseVersion !== null && op.baseVersion < (current.version as number)
    ? { staleBase: [op.baseVersion, current.version] }
    : {};
}

function auditValues(ctx: OpContext, op: SyncOp, action: string, diff: Record<string, unknown> | null) {
  const { session, now } = ctx;
  return sql`${uuidv7(now)}, ${SQL_NAMES[op.entity].table}, ${op.entityId}, ${session.user.id},
    ${session.deviceId}, ${action}, ${diff ? JSON.stringify(diff) : null}, ${now}`;
}

async function commit(
  ctx: OpContext,
  op: SyncOp,
  fields: Row,
  decision: Exclude<Decision, { reject: SyncRejectReason }>,
): Promise<OpResult | 'lost_race'> {
  const { db, session, now } = ctx;
  const names = SQL_NAMES[op.entity];
  // True only if this batch's write landed: the row now carries the version taken for it.
  const landed = sql`EXISTS (SELECT 1 FROM ${sql.raw(names.table)}
    WHERE ${sql.raw(names.key)} = ${op.entityId} AND version = ${CURRENT_VERSION})`;
  const result =
    decision.result ??
    sql`json_object('opId', ${op.opId}, 'outcome', 'applied', 'version', ${CURRENT_VERSION})`;
  try {
    const results = await withVersion(
      db,
      ...decision.statements,
      sql`INSERT INTO audit_log (id, entity, entity_id, user_id, device_id, action, diff, at)
          SELECT ${auditValues(ctx, op, decision.action, decision.diff)} WHERE ${landed}`,
      sql`INSERT INTO sync_ops (op_id, device_id, result, applied_at)
          SELECT ${op.opId}, ${session.deviceId}, ${result}, ${now} WHERE ${landed}`,
      sql`SELECT result FROM sync_ops WHERE op_id = ${op.opId} AND device_id = ${session.deviceId}`,
    );
    const row = results.at(-1)?.results[0] as { result: string } | undefined;
    return row ? (JSON.parse(row.result) as OpResult) : 'lost_race';
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const message = errorChain(err);
    if (message.includes('sync_ops.op_id')) {
      // Either this device sent the op twice at once (return the stored answer), or another
      // device used the same opId (refuse; never reveal its result).
      const stored = await db
        .select({ result: syncOps.result })
        .from(syncOps)
        .where(and(eq(syncOps.opId, op.opId), eq(syncOps.deviceId, session.deviceId)))
        .get();
      return stored
        ? (JSON.parse(stored.result) as OpResult)
        : { opId: op.opId, outcome: 'rejected', reason: 'invalid' };
    }
    const reason: SyncRejectReason = message.includes('patients.phone_e164')
      ? 'phone_taken'
      : message.includes('procedures.code')
        ? 'code_taken'
        : 'exists';
    return storeRejection(ctx, op, reason, fields);
  }
}

/**
 * Stores a refusal, so a re-sent op gets the same answer (PRD §7.4 step 1), and keeps the refused
 * values in `audit_log` so nothing the user entered is lost without a trace (PRD §7.4 step 3).
 */
/**
 * What a refusal keeps in the audit log. For patients only the field names: the values could be a
 * real person's details for a patient that is (or later is) erased, and a refused row is not tied
 * to that patient's id (ADR 0007). Other entities keep the values, so nothing entered is lost.
 */
function refusedDiff(
  op: SyncOp,
  reason: SyncRejectReason,
  fields: Row | null,
  redact = false,
): Record<string, unknown> | null {
  if (!fields) return null;
  const namesOnly = redact || op.entity === 'patients' || reason === 'patient_not_found';
  return namesOnly ? { kind: op.kind, fieldNames: Object.keys(fields) } : { kind: op.kind, fields };
}

async function storeRejection(
  ctx: OpContext,
  op: SyncOp,
  reason: SyncRejectReason,
  fields: Row | null,
  redact = false,
): Promise<OpResult> {
  const { db, session, now } = ctx;
  const result: OpResult = { opId: op.opId, outcome: 'rejected', reason };
  try {
    await rawBatch(db, [
      sql`INSERT INTO sync_ops (op_id, device_id, result, applied_at)
          VALUES (${op.opId}, ${session.deviceId}, ${JSON.stringify(result)}, ${now})`,
      sql`INSERT INTO audit_log (id, entity, entity_id, user_id, device_id, action, diff, at)
          VALUES (${auditValues(ctx, op, `rejected:${reason}`, refusedDiff(op, reason, fields, redact))})`,
    ]);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const stored = await db
      .select({ result: syncOps.result })
      .from(syncOps)
      .where(and(eq(syncOps.opId, op.opId), eq(syncOps.deviceId, session.deviceId)))
      .get();
    return stored
      ? (JSON.parse(stored.result) as OpResult)
      : { opId: op.opId, outcome: 'rejected', reason: 'invalid' };
  }
  return result;
}

function errorChain(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) parts.push(e.message);
  return parts.join(' | ');
}
