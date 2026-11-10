/**
 * Randomized multi-device sync simulation (PRD §7.10, M2).
 *
 * Three devices (the Doctor and two Staff), each with its own IndexedDB and two real sync engines
 * on it: the open app's and the service worker's (`createSession` + `createSync`, as in `sw.ts`).
 * They talk to the real API (`apps/api`'s Hono app) on an in-process SQLite D1 with every
 * migration applied (`sqliteD1.ts` says why). Each run gives the devices a random plan of writes
 * while their network goes online, offline or flaky; a flaky request is either dropped before it
 * reaches the server or its response is lost after the server applied it (so the op is sent
 * again). Latency varies, so responses can overtake each other, and the app and the service worker
 * may sync at the same moment with no shared lock (a browser without Web Locks).
 *
 * At every step, on every device:
 * - its own changes still waiting for the server are shown (a pull never hides them);
 * - no row steps back to an older version.
 * After every run the network comes back and the devices settle; then:
 * - zero lost ops: every outbox is empty and the server answered every op exactly once
 *   (one `sync_ops` row and one `audit_log` row per op, however often it was re-sent);
 * - exactly one winner per overlap: no two active bookings of the run overlap, and every
 *   booking marked `clash` names the booking it lost to;
 * - convergence: every device holds exactly the server's version of every row of the run, and
 *   nothing the server refused.
 *
 * Runs: `SYNC_SIM_RUNS` (default 25 in `pnpm test`; CI runs 1,000 in its own job). Independent
 * worlds (a server and its three devices) take runs side by side (`SYNC_SIM_WORLDS`, default 4).
 * A run's plan comes from its seed (`SYNC_SIM_SEED` + run number, shown in the test name); timing
 * still varies between machines, so re-run a failing seed a few times when reproducing it.
 */
import 'fake-indexeddb/auto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLASH_STATUSES, type OpResult, type SyncOp, uuidv7 } from '@yegna/shared/client';
import { addDays, localDateOf, localToUtc, weekdayOf } from '@yegna/time';
import { YegnaDb } from '../../src/lib/db.ts';
import { type Session, createSession } from '../../src/lib/session.ts';
import { type Sync, createSync } from '../../src/lib/sync.ts';
import { SqliteD1 } from './sqliteD1.ts';

const RUNS = Number(process.env.SYNC_SIM_RUNS ?? 25);
const WORLDS = Math.max(1, Math.min(RUNS, Number(process.env.SYNC_SIM_WORLDS ?? 4)));
const BASE_SEED = Number(process.env.SYNC_SIM_SEED ?? 20261110);
const STEPS_PER_RUN = { min: 10, max: 28 };
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// The server: the API app and its test D1, loaded by path so this package's type check does not
// pull in the Worker's types (the two apps have different globals).

type ServerEnv = Record<string, unknown> & { DB: SqliteD1 };
interface ApiApp {
  request(path: string, init: RequestInit | undefined, env: ServerEnv): Response | Promise<Response>;
}
interface ApiTestHelpers {
  createTestEnv(): Promise<{ env: Record<string, unknown>; dispose: () => Promise<void> }>;
  SETUP_CODE: string;
}

const API_DIR = join(import.meta.dirname, '..', '..', '..', 'api');
let app: ApiApp;
let helpers: ApiTestHelpers;
/** The Worker's vars (origin, environment, setup code); each world brings its own database. */
let vars: Record<string, unknown>;
let disposeVars: (() => Promise<void>) | undefined;

// ---------------------------------------------------------------------------------------------
// Worlds and devices

type Net = 'online' | 'offline' | 'flaky';

interface Device {
  label: string;
  role: 'doctor' | 'staff';
  db: YegnaDb;
  session: Session;
  /** The open app's sync engine. */
  sync: Sync;
  /**
   * The service worker's engine on the same device store (own session copy, as in `sw.ts`). No
   * sync lock is shared with the app here: the worst case, a browser without Web Locks, where the
   * two can run at once and an older response may arrive after a newer one.
   */
  worker: Sync;
  net: Net;
  /** Highest version this device has held per row (a row must never step back to an older one). */
  seen: Map<string, number>;
  /** Decides each flaky request; seeded per run so a run's network plan is repeatable. */
  netRng: () => number;
}

/** One server (its own database) and its three devices. A world runs one run at a time. */
interface World {
  env: ServerEnv;
  devices: Device[];
}

/** Every answer the server gave per op (delivered or lost), to check a re-send gets the original one. */
const answers = new Map<string, OpResult[]>();

async function recordAnswers(body: ArrayBuffer) {
  try {
    const { results } = JSON.parse(new TextDecoder().decode(body)) as { results?: OpResult[] };
    for (const r of results ?? []) answers.set(r.opId, [...(answers.get(r.opId) ?? []), r]);
  } catch {
    /* not a sync answer */
  }
}

const stats = { runs: 0, ops: 0, dropped: 0, lostResponses: 0, outcomes: {} as Record<string, number> };

/** Network latency: usually a few ms, sometimes a slow answer (so responses overtake each other). */
const jitter = (device: Device) =>
  new Promise((r) => setTimeout(r, Math.floor(device.netRng() * (device.netRng() < 0.2 ? 40 : 8))));

/** `fetch` for one device: its network decides whether the request (or its response) gets through. */
function networkFor(env: ServerEnv, device: Device): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (device.net === 'offline' || (device.net === 'flaky' && device.netRng() < 0.25)) {
      stats.dropped++;
      throw new TypeError('Failed to fetch');
    }
    // Latency both ways, so responses can arrive in a different order than requests were sent.
    await jitter(device);
    const res = await app.request(url.pathname, init, env);
    await jitter(device);
    const body = await res.arrayBuffer();
    if (url.pathname === '/sync') await recordAnswers(body);
    if (device.net === 'flaky' && device.netRng() < 0.25) {
      // The server has done the work; the phone never hears back.
      stats.lostResponses++;
      throw new TypeError('Failed to fetch');
    }
    return new Response(body, { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

async function createWorld(n: number): Promise<World> {
  const env: ServerEnv = { ...vars, DB: new SqliteD1() };
  const world: World = { env, devices: [] };

  async function addDevice(label: string, role: Device['role'], signIn: (s: Session) => Promise<void>) {
    const db = new YegnaDb(`sim-${n}-${label}`);
    const device = { label, role, db, net: 'online', netRng: Math.random, seen: new Map() } as Device;
    device.session = createSession({ db, fetchImpl: networkFor(env, device) });
    await signIn(device.session);
    device.sync = createSync({ db, session: device.session });
    const workerSession = createSession({ db, fetchImpl: networkFor(env, device) });
    await workerSession.init({ use: false });
    device.worker = createSync({ db, session: workerSession });
    world.devices.push(device);
    return device;
  }

  const doctor = await addDevice('doctor', 'doctor', (s) =>
    s.setup({
      code: helpers.SETUP_CODE,
      name: 'Dr. Selam',
      pin: '258014',
      deviceLabel: 'Doctor phone',
      locale: 'am',
      calendar: 'ethiopian',
    }),
  );
  for (const [name, pin] of [
    ['Hana', '473190'],
    ['ሔዋን', '615204'],
  ] as const) {
    const res = await app.request(
      '/admin/users',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${doctor.session.current.value!.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: uuidv7(), name, pin }),
      },
      env,
    );
    expect(res.status).toBe(201);
    await addDevice(name, 'staff', (s) => s.enrol({ name, pin, deviceLabel: `${name} phone` }));
  }
  // First fill, so later runs only pull changes.
  await Promise.all(world.devices.map((d) => d.sync.syncNow()));
  for (const d of world.devices) expect(d.sync.state.value).toBe('idle');
  return world;
}

const idle: World[] = [];
const waiting: ((world: World) => void)[] = [];
const allWorlds: World[] = [];

/** Runs `fn` on a world nobody else is using (waits for one to come free). */
async function withWorld(fn: (world: World) => Promise<void>): Promise<void> {
  const world = idle.pop() ?? (await new Promise<World>((resolve) => waiting.push(resolve)));
  try {
    await fn(world);
  } finally {
    const next = waiting.shift();
    if (next) next(world);
    else idle.push(world);
  }
}

beforeAll(async () => {
  // Each simulated phone has its own sync lock; Node's one `navigator.locks` would serialize them.
  vi.stubGlobal('navigator', { onLine: true });
  helpers = (await import(join(API_DIR, 'test', 'helpers.ts'))) as ApiTestHelpers;
  app = ((await import(join(API_DIR, 'src', 'index.ts'))) as { default: ApiApp }).default;
  ({ env: vars, dispose: disposeVars } = await helpers.createTestEnv());
  allWorlds.push(...(await Promise.all(Array.from({ length: WORLDS }, (_, n) => createWorld(n)))));
  idle.push(...allWorlds);
}, 180_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const world of allWorlds) world.env.DB.close();
  await disposeVars?.();
  process.stdout.write(`sync simulation: ${JSON.stringify(stats)}\n`);
});

// ---------------------------------------------------------------------------------------------
// One run

/** Small seeded PRNG (mulberry32): the same seed gives the same plan. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Monday `weeks` weeks after the next one (open 09:00–18:00, lunch 12–13, by the seeded weekly hours). */
function mondayAfter(weeks: number) {
  let date = addDays(localDateOf(Date.now()), 1);
  while (weekdayOf(date) !== 1) date = addDays(date, 1);
  return addDays(date, 7 * weeks);
}

const NAMES = ['Abebe Kebede', 'Almaz Tesfaye', 'ሰላም ገብሬ', 'Dawit Haile', 'ትዕግሥት አለሙ', 'Meron Bekele'];
let phoneSeq = 0;

interface RunRecord {
  written: { device: Device; op: SyncOp }[];
  patientIds: Set<string>;
  dayStart: number;
  dayEnd: number;
  runStart: number;
}

async function runSimulation(world: World, run: number, seed: number) {
  const { devices } = world;
  const rng = prng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
  const chance = (p: number) => rng() < p;

  // Each run books its own day, so runs sharing a world don't touch each other's bookings.
  const date = mondayAfter(run + 1);
  const dayStart = localToUtc(date, 0);
  // Mostly inside clinic hours, sometimes before opening or running past closing.
  const slot = () => localToUtc(date, (8 * 4 + Math.floor(rng() * 40)) * 15);
  const duration = () => pick([30, 45, 60, 90]);
  const record: RunRecord = {
    written: [],
    patientIds: new Set(),
    dayStart,
    dayEnd: dayStart + DAY_MS,
    runStart: Date.now(),
  };
  const inFlight: Promise<unknown>[] = [];
  for (const [i, d] of devices.entries()) {
    d.net = 'online';
    d.netRng = prng(seed * 31 + i);
  }

  /** A write the user could make on `device`'s screen now, or null if there is none. */
  async function plannedWrite(device: Device): Promise<(() => Promise<SyncOp>) | null> {
    const { db, sync, role } = device;
    const patients = (await db.patients.bulkGet([...record.patientIds])).filter(
      (p) => p !== undefined && p.deletedAt === null,
    );
    const bookings = (await db.bookings.where('startAt').between(dayStart, record.dayEnd).toArray()).filter(
      (b) => b.deletedAt === null,
    );
    const roll = rng();
    if (roll < 0.2 || patients.length === 0) {
      const phone = `+251911${String(++phoneSeq).padStart(6, '0')}`;
      const name = pick(NAMES);
      return async () => {
        const op = await sync.write('patients', 'create', { name, phoneE164: phone });
        record.patientIds.add(op.entityId);
        return op;
      };
    }
    if (roll < 0.55) {
      const fields = {
        patientId: pick(patients)!.id,
        procedureId: null,
        startAt: slot(),
        durationMin: duration(),
        ...(chance(0.3) ? { note: 'ጥርስ ህመም' } : {}),
      };
      return () => sync.write('bookings', 'create', fields);
    }
    if (roll < 0.7 && bookings.length) {
      const b = pick(bookings);
      const fields = { startAt: slot(), durationMin: duration() };
      if (['pending_approval', 'approved', 'clash', 'needs_fixing'].includes(b.status)) {
        return () => sync.write('bookings', 'update', fields, b.id);
      }
    }
    if (roll < 0.8 && bookings.length) {
      const b = pick(bookings);
      if (b.status !== 'cancelled' && b.status !== 'done') {
        return () => sync.write('bookings', 'update', { status: 'cancelled', cancelReason: 'ታመመ' }, b.id);
      }
    }
    if (roll < 0.88 && bookings.length) {
      const b = pick(bookings);
      if (role === 'doctor' && b.status === 'pending_approval') {
        return () => sync.write('bookings', 'update', { status: 'approved' }, b.id);
      }
      if (b.status === 'approved') return () => sync.write('bookings', 'update', { status: 'arrived' }, b.id);
    }
    if (roll < 0.96) {
      const id = pick(patients)!.id;
      const fields = chance(0.5) ? { name: pick(NAMES) } : { note: 'ይደውሉ' };
      return () => sync.write('patients', 'update', fields, id);
    }
    const id = pick(patients)!.id;
    return () => sync.write('patients', 'delete', {}, id);
  }

  const steps = STEPS_PER_RUN.min + Math.floor(rng() * (STEPS_PER_RUN.max - STEPS_PER_RUN.min + 1));
  for (let step = 0; step < steps; step++) {
    const device = pick(devices);
    const roll = rng();
    if (roll < 0.25) {
      device.net = pick<Net>(['online', 'online', 'offline', 'offline', 'flaky']);
    } else if (roll < 0.85) {
      const write = await plannedWrite(device);
      try {
        // A write starts a sync in the background (not awaited), like a tap in the app. It also
        // asks for a Background Sync, which may wake the service worker at the same moment.
        if (write) record.written.push({ device, op: await write() });
        if (write && chance(0.5)) inFlight.push(device.worker.syncNow());
      } catch (err) {
        // A sync in between brought the patient's deletion: the screen would no longer offer it.
        if (!(err instanceof Error && err.message === 'row deleted')) throw err;
      }
    } else if (roll < 0.93) {
      inFlight.push(device.sync.syncNow());
    } else {
      inFlight.push(device.worker.syncNow());
    }
    for (const d of devices) await checkDevice(d, record);
    await expectOneWinner(world.env, record);
    // Let requests of different devices interleave on the server.
    if (chance(0.5)) await new Promise((r) => setTimeout(r, Math.floor(rng() * 4)));
  }

  await settle(devices, inFlight, record);
  await checkRun(world, record);
}

/** Network back for everyone; sync until every outbox is empty, then once more so all pull the end state. */
async function settle(devices: Device[], inFlight: Promise<unknown>[], record: RunRecord) {
  await Promise.allSettled(inFlight);
  for (const d of devices) await checkDevice(d, record);
  for (const d of devices) d.net = 'online';
  for (let pass = 0; pass < 20; pass++) {
    await Promise.all(devices.map((d) => d.sync.syncNow()));
    const left = await Promise.all(devices.map((d) => d.db.outbox.count()));
    if (left.every((n) => n === 0)) {
      // Every op is on the server now: one pull each sees the final state.
      for (const d of devices) await d.sync.syncNow();
      return;
    }
  }
  throw new Error('devices did not settle: ops still waiting after 20 passes');
}

// ---------------------------------------------------------------------------------------------
// Checks

/**
 * Exactly one winner per overlap, at every step: no two active bookings of the run overlap, and a
 * booking marked `clash` names a booking that exists.
 */
async function expectOneWinner(env: ServerEnv, run: RunRecord) {
  const bookings = (
    await env.DB.prepare(
      `SELECT id, status, start_at, duration_min, clash_with_id FROM bookings WHERE start_at >= ? AND start_at < ?`,
    )
      .bind(run.dayStart, run.dayEnd)
      .all<Omit<ServerBooking, 'version'>>()
  ).results;
  const active = bookings
    .filter((b) => (CLASH_STATUSES as readonly string[]).includes(b.status))
    .sort((a, b) => a.start_at - b.start_at);
  for (let i = 1; i < active.length; i++) {
    const prev = active[i - 1]!;
    const next = active[i]!;
    expect(prev.start_at + prev.duration_min * 60_000, `overlap ${prev.id} / ${next.id}`).toBeLessThanOrEqual(
      next.start_at,
    );
  }
  const ids = new Set(bookings.map((b) => b.id));
  for (const b of bookings.filter((x) => x.status === 'clash')) {
    expect(b.clash_with_id !== null && ids.has(b.clash_with_id), `clash ${b.id} names its winner`).toBe(true);
  }
}

/**
 * What must hold on a device at any moment, not only after the final sync:
 * - it shows its own changes still waiting for the server (PRD §7.2): a pull never hides them.
 *   Status changes are left out (the device works the status out itself), and so are deleted rows
 *   (pending edits are not replayed onto a tombstone);
 * - no row steps back to an older version (a late response must not undo a newer one).
 */
async function checkDevice(device: Device, run: RunRecord) {
  const { db } = device;
  await db.transaction('r', db.outbox, db.patients, db.bookings, async () => {
    const rows = [
      ...(await db.patients.bulkGet([...run.patientIds])).flatMap((r) =>
        r ? [['patients', r] as const] : [],
      ),
      ...(await db.bookings.where('startAt').between(run.dayStart, run.dayEnd).toArray()).map(
        (r) => ['bookings', r] as const,
      ),
    ];
    for (const [entity, row] of rows) {
      const key = `${entity}/${row.id}`;
      const before = device.seen.get(key) ?? 0;
      expect(row.version, `${device.label}: ${key} stepped back`).toBeGreaterThanOrEqual(before);
      device.seen.set(key, row.version);
    }
    const latest = new Map<string, Record<string, unknown>>();
    for (const { op } of await db.outbox.orderBy('seq').toArray()) {
      if (op.entity !== 'patients' && op.entity !== 'bookings') continue;
      if (op.kind === 'delete') continue;
      const key = `${op.entity}/${op.entityId}`;
      latest.set(key, { ...latest.get(key), ...op.fields });
    }
    for (const [key, fields] of latest) {
      const [entity, id] = key.split('/') as ['patients' | 'bookings', string];
      const row = (await db.entity(entity).get(id)) as Record<string, unknown> | undefined;
      if (!row || row.deletedAt != null) continue;
      for (const [field, value] of Object.entries(fields)) {
        if (field === 'status') continue;
        expect(row[field], `${device.label}: pending ${field} of ${key} shown`).toEqual(value);
      }
    }
  });
}

/** D1 allows 100 bound values per statement. */
async function selectIn<T>(env: ServerEnv, query: (marks: string) => string, ids: string[]): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const res = await env.DB.prepare(query(chunk.map(() => '?').join(',')))
      .bind(...chunk)
      .all<T>();
    rows.push(...res.results);
  }
  return rows;
}

interface ServerBooking {
  id: string;
  status: string;
  start_at: number;
  duration_min: number;
  version: number;
  clash_with_id: string | null;
}

async function checkRun({ env, devices }: World, run: RunRecord) {
  const { written, dayStart, dayEnd } = run;

  // Zero lost ops: nothing waits, and the server answered each op once, for the device that made it.
  for (const d of devices) {
    expect(await d.db.outbox.count(), `${d.label} outbox`).toBe(0);
    expect(d.session.current.value, `${d.label} still signed in`).not.toBeNull();
  }
  const answered = await selectIn<{ op_id: string; device_id: string; result: string }>(
    env,
    (m) => `SELECT op_id, device_id, result FROM sync_ops WHERE op_id IN (${m})`,
    written.map((w) => w.op.opId),
  );
  expect(answered).toHaveLength(written.length);
  const byOp = new Map(answered.map((a) => [a.op_id, a]));
  for (const { device, op } of written) {
    const row = byOp.get(op.opId);
    expect(row, `op ${op.opId} answered`).toBeDefined();
    expect(row!.device_id).toBe(device.session.current.value!.deviceId);
    const stored = JSON.parse(row!.result) as OpResult;
    stats.outcomes[stored.outcome] = (stats.outcomes[stored.outcome] ?? 0) + 1;
    // Idempotent re-sends: every answer to this op, first or repeated, is the stored one.
    const given = answers.get(op.opId) ?? [];
    expect(given.length, `op ${op.opId} answered at least once`).toBeGreaterThan(0);
    for (const answer of given) expect(answer, `re-sent op ${op.opId}`).toEqual(stored);
    answers.delete(op.opId);
  }
  // Applied once, however often it was re-sent: one audit row per op (counted per row changed,
  // so a mismatch shows which row and what was written).
  const audits = (
    await env.DB.prepare('SELECT entity_id, action, device_id FROM audit_log WHERE at >= ? ORDER BY at')
      .bind(run.runStart)
      .all<{ entity_id: string; action: string; device_id: string }>()
  ).results;
  const count = (ids: string[]) =>
    ids.reduce<Record<string, number>>((m, id) => ({ ...m, [id]: (m[id] ?? 0) + 1 }), {});
  const auditCounts = count(audits.map((a) => a.entity_id));
  const opCounts = count(written.map((w) => w.op.entityId));
  if (
    JSON.stringify(Object.entries(auditCounts).sort()) !== JSON.stringify(Object.entries(opCounts).sort())
  ) {
    const ops = written.map(
      ({ device, op }) =>
        `${device.label} ${op.kind} ${op.entity}/${op.entityId} ${JSON.stringify(op.fields)}`,
    );
    expect({ audits, ops }, 'one audit row per op').toEqual({ audits: '(one per op)', ops });
  }

  await expectOneWinner(env, run);
  const bookings = (
    await env.DB.prepare(
      `SELECT id, status, start_at, duration_min, version, clash_with_id FROM bookings
       WHERE start_at >= ? AND start_at < ?`,
    )
      .bind(dayStart, dayEnd)
      .all<ServerBooking>()
  ).results;
  // Convergence: each device holds exactly the server's rows (and nothing the server refused).
  const serverBookings = new Map(
    bookings.map((b) => [
      b.id,
      { status: b.status, startAt: b.start_at, durationMin: b.duration_min, version: b.version },
    ]),
  );
  const serverPatients = new Map(
    (
      await selectIn<{ id: string; name: string; version: number; deleted_at: number | null }>(
        env,
        (m) => `SELECT id, name, version, deleted_at FROM patients WHERE id IN (${m})`,
        [...run.patientIds],
      )
    ).map((p) => [p.id, p]),
  );
  for (const d of devices) {
    const local = await d.db.bookings.where('startAt').between(dayStart, dayEnd).toArray();
    const localBookings = new Map(
      local.map((b) => [
        b.id,
        { status: b.status, startAt: b.startAt, durationMin: b.durationMin, version: b.version },
      ]),
    );
    expect(localBookings, `${d.label} bookings`).toEqual(serverBookings);
    expect(
      local.filter((b) => b.provisional),
      `${d.label} provisional bookings`,
    ).toEqual([]);
    for (const id of run.patientIds) {
      const server = serverPatients.get(id);
      const mine = await d.db.patients.get(id);
      if (!server) {
        expect(mine, `${d.label} keeps no refused patient`).toBeUndefined();
        continue;
      }
      expect(mine?.version, `${d.label} patient version`).toBe(server.version);
      expect(mine?.deletedAt ?? null).toBe(server.deleted_at);
      if (server.deleted_at === null) expect(mine?.name).toBe(server.name);
    }
  }

  // Every device holds the very same rows, every field (not only those compared with the server).
  const snapshot = async (d: Device) => {
    const strip = ({ provisional, ...row }: { provisional?: boolean; id: string }) => {
      expect(provisional ?? false, `${d.label} row ${String(row.id)} not sent yet`).toBe(false);
      return row;
    };
    return {
      bookings: (await d.db.bookings.where('startAt').between(dayStart, dayEnd).sortBy('id')).map(strip),
      patients: (await d.db.patients.bulkGet([...run.patientIds].sort())).map((p) => (p ? strip(p) : null)),
    };
  };
  const [first, ...others] = await Promise.all(devices.map(snapshot));
  for (const [i, other] of others.entries()) {
    expect(other, `${devices[i + 1]!.label} holds the same rows as ${devices[0]!.label}`).toEqual(first);
  }

  // Free the daily op budget (2,000 per device) for the next run; the stored answers stay, so
  // re-sends are still recognised. A real device never sends this many in a day.
  await env.DB.prepare('UPDATE sync_ops SET applied_at = applied_at - ?')
    .bind(2 * DAY_MS)
    .run();
  stats.runs++;
  stats.ops += written.length;
}

// ---------------------------------------------------------------------------------------------

describe('randomized multi-device sync (PRD §7.10)', () => {
  for (let run = 0; run < RUNS; run++) {
    const seed = BASE_SEED + run;
    it.concurrent(
      `run ${run + 1}/${RUNS} (seed ${seed})`,
      () => withWorld((world) => runSimulation(world, run, seed)),
      // Includes waiting for a free world.
      600_000,
    );
  }
});

describe('randomized multi-device sync: coverage', () => {
  it('exercised the hard cases', () => {
    if (RUNS < 10) return;
    expect(stats.lostResponses, 'responses lost after the server applied the op').toBeGreaterThan(0);
    expect(stats.dropped, 'requests dropped offline').toBeGreaterThan(0);
    expect(stats.outcomes.clash ?? 0, 'clashes').toBeGreaterThan(0);
    expect(stats.outcomes.needs_fixing ?? 0, 'bookings that need fixing').toBeGreaterThan(0);
    expect(stats.outcomes.rejected ?? 0, 'refused ops').toBeGreaterThan(0);
  });
});
