/**
 * `/sync` must stay inside the free plan's 50 D1 queries per Worker invocation, whatever the
 * device sends (PRD §19). Ops beyond the per-request budget are left unanswered; the device keeps
 * them in its outbox and calls again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type EnrolResponse, MAX_OPS_PER_SYNC, type SyncOp, type SyncResponse, uuidv7 } from '@yegna/shared';
import { addDays, localDateOf, localToUtc, weekdayOf } from '@yegna/time';
import { type Call, caller, countingD1, createTestEnv, resetDb, setupDoctor } from './helpers.ts';

const FREE_PLAN_QUERIES = 50;
/** Draining a full outbox takes many rounds against a local D1. */
const SLOW = 180_000;

let env: Env;
let dispose: () => Promise<void>;
let counter: ReturnType<typeof countingD1>;
let call: Call;
let doctor: EnrolResponse;

beforeAll(async () => {
  const created = await createTestEnv();
  dispose = created.dispose;
  counter = countingD1(created.env.DB);
  env = { ...created.env, DB: counter.db };
  call = caller(env);
});
afterAll(() => dispose());
beforeEach(async () => {
  await resetDb(env);
  doctor = await setupDoctor(call);
});

function monday(): string {
  let date = addDays(localDateOf(Date.now()), 1);
  while (weekdayOf(date) !== 1) date = addDays(date, 1);
  return date;
}

function op(
  entity: SyncOp['entity'],
  kind: SyncOp['kind'],
  fields: Record<string, unknown>,
  entityId = uuidv7(),
): SyncOp {
  return {
    opId: uuidv7(),
    entity,
    entityId,
    kind,
    fields,
    baseVersion: null,
    at: Date.now(),
    userId: doctor.user.id,
  };
}

/** A full outbox: 100 patients, each with a booking (week after week, so no clashes). */
function fullOutbox(): SyncOp[] {
  const ops: SyncOp[] = [];
  const first = monday();
  for (let i = 0; i < MAX_OPS_PER_SYNC / 2; i++) {
    const p = op('patients', 'create', { name: `P${i}`, phoneE164: `+251911${String(i).padStart(6, '0')}` });
    const date = addDays(first, 7 * Math.floor(i / 8));
    ops.push(
      p,
      op('bookings', 'create', {
        patientId: p.entityId,
        procedureId: null,
        startAt: localToUtc(date, 540 + (i % 8) * 60),
        durationMin: 60,
      }),
    );
  }
  return ops;
}

async function sync(ops: SyncOp[], cursor = 0) {
  counter.reset();
  const res = await call('POST', '/sync', {
    token: doctor.token,
    body: { deviceId: doctor.deviceId, cursor, ops },
  });
  expect(res.status).toBe(200);
  return { json: res.json as unknown as SyncResponse, queries: counter.queries() };
}

describe('/sync query budget', () => {
  it(
    'never exceeds the free plan’s queries per invocation, and a device drains a full outbox by looping',
    async () => {
      let outbox = fullOutbox();
      let cursor = 0;
      let rounds = 0;
      const perRound: number[] = [];
      while (outbox.length && rounds++ < 100) {
        const { json, queries } = await sync(outbox, cursor);
        expect(queries).toBeLessThan(FREE_PLAN_QUERIES);
        perRound.push(json.results.length);
        expect(json.results.length).toBeGreaterThan(0);
        // Answers come for a prefix of the ops, in order.
        expect(json.results.map((r) => r.opId)).toEqual(
          outbox.slice(0, json.results.length).map((o) => o.opId),
        );
        expect(json.results.every((r) => r.outcome === 'applied')).toBe(true);
        outbox = outbox.slice(json.results.length);
        cursor = json.newCursor;
      }
      expect(outbox).toEqual([]);
      // Patient + booking pairs: a request should still carry a useful number of ops.
      expect(Math.min(...perRound.slice(0, -1))).toBeGreaterThanOrEqual(8);
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM bookings').first<{ n: number }>();
      expect(n?.n).toBe(MAX_OPS_PER_SYNC / 2);
    },
    SLOW,
  );

  it(
    'answers re-sent ops cheaply, so already-applied ops can’t block the outbox',
    async () => {
      const ops = fullOutbox();
      let done = 0;
      while (done < ops.length) done += (await sync(ops.slice(done))).json.results.length;
      // The whole outbox again (as after a lost response): all answered from stored results.
      const { json, queries } = await sync(ops);
      expect(json.results).toHaveLength(ops.length);
      expect(queries).toBeLessThan(FREE_PLAN_QUERIES);
    },
    SLOW,
  );
});
