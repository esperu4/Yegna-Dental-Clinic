/**
 * Device sync (PRD §7.2–7.4). Every write goes to the working copy and the outbox at once, so the
 * UI never waits for the network; `syncNow` then sends the outbox and pulls changes.
 *
 * M1 runs this while the app is open and online (after each write, every 30 s, on `online` and
 * when the app becomes visible). The service worker, Background Sync and the status pill are M2.
 */
import { signal } from '@preact/signals';
import {
  MAX_OPS_PER_SYNC,
  type OpKind,
  PULL_ENTITIES,
  type PullEntity,
  type Role,
  type SyncOp,
  type SyncResponse,
  type WriteEntity,
  rowKey,
  uuidv7,
} from '@yegna/shared/client';
import { ApiError } from './api.ts';
import { type Notice, type OutboxEntry, type YegnaDb, db as defaultDb } from './db.ts';
import { applyLocally } from './localOps.ts';
import { type Session, session as defaultSession } from './session.ts';

export const AUTO_SYNC_EVERY_MS = 30_000;
/** Upper bound on request rounds in one `syncNow` (outbox pages + pull pages). */
const MAX_ROUNDS = 50;
const CURSOR_KEY = 'syncCursor';
/** Set once the first full pull has finished (until then the server applies the booking window). */
const FILLED_KEY = 'syncFilled';
/** Until this time the device only pulls: the server held its ops back (daily budget). */
const HOLD_OPS_KEY = 'syncHoldOpsUntil';
/** Notices older than this are dropped, so entered patient details don't linger (PRD §18). */
export const NOTICE_TTL_MS = 30 * 86_400_000;

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

type AnyRow = Record<string, unknown>;

export function createSync(deps: { db?: YegnaDb; session?: Session; now?: () => number } = {}) {
  const store = deps.db ?? defaultDb;
  const auth = deps.session ?? defaultSession;
  const now = deps.now ?? Date.now;

  const state = signal<SyncState>('idle');
  const lastSyncedAt = signal<number | null>(null);
  const lastError = signal<string | null>(null);
  const pendingCount = signal(0);
  /** Refused ops and clashes, oldest first, until dismissed (stored, so they survive a reload). */
  const notices = signal<Notice[]>([]);

  let running: Promise<void> | null = null;
  let rerun = false;

  /** Everything `applyResponse` touches, so a response is applied all at once or not at all. */
  const responseTables = () => [
    store.meta,
    store.outbox,
    store.notices,
    ...PULL_ENTITIES.map((e) => store.entity(e)),
  ];

  async function refresh() {
    await store.notices
      .where('at')
      .below(now() - NOTICE_TTL_MS)
      .delete();
    pendingCount.value = await store.outbox.count();
    notices.value = await store.notices.orderBy('at').toArray();
  }

  /**
   * Change one row: applied to the working copy and queued in the outbox in one transaction,
   * then sent in the background. Returns the op (its `entityId` is the new row's id on create).
   */
  async function write(
    entity: WriteEntity,
    kind: OpKind,
    fields: Record<string, unknown>,
    entityId: string = uuidv7(now()),
  ): Promise<SyncOp> {
    const signedIn = auth.current.value;
    if (!signedIn) throw new Error('not signed in');
    const op: SyncOp = {
      opId: uuidv7(now()),
      entity,
      entityId,
      kind,
      fields,
      baseVersion: null,
      at: now(),
      userId: signedIn.user.id,
    };
    const table = store.entity(entity);
    await store.transaction('rw', table, store.outbox, async () => {
      const row = await table.get(entityId);
      // Deleted on the server: there is nothing left to change (the UI never offers it).
      if (kind !== 'create' && row?.deletedAt != null) throw new Error('row deleted');
      // Version 0 = created here and not yet on the server: there is no base to compare with.
      op.baseVersion = kind === 'create' || !row?.version ? null : row.version;
      await table.put(applyLocally(row, op, signedIn.user.role) as never);
      await store.outbox.add({ op });
    });
    await refresh();
    void syncNow();
    return op;
  }

  /** Send the outbox and pull changes. Concurrent calls share one run (and trigger one more). */
  function syncNow(): Promise<void> {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          await runOnce();
        } while (rerun && state.value === 'idle');
      } finally {
        running = null;
      }
    })();
    return running;
  }

  async function runOnce(): Promise<void> {
    const signedIn = auth.current.value;
    if (!signedIn) return;
    state.value = 'syncing';
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const holdOps = ((await store.getMeta<number>(HOLD_OPS_KEY)) ?? 0) > now();
        const entries = holdOps ? [] : await store.outbox.orderBy('seq').limit(MAX_OPS_PER_SYNC).toArray();
        const cursor = (await store.getMeta<number>(CURSOR_KEY)) ?? 0;
        const initial = !(await store.getMeta<boolean>(FILLED_KEY));
        const res = await auth.authed<SyncResponse>('/sync', {
          body: { deviceId: signedIn.deviceId, cursor, initial, ops: entries.map((e) => e.op) },
        });
        await applyResponse(entries, res, signedIn.user.role, initial);
        if (!res.more && (holdOps || res.retryOpsAfterMs || (await store.outbox.count()) === 0)) break;
        // The server answered none of our ops this time (it ran out of budget): try again later.
        if (!res.more && entries.length > 0 && res.results.length === 0) break;
      }
      state.value = 'idle';
      lastError.value = null;
      lastSyncedAt.value = now();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'server_error';
      // A 401 has already wiped the device (session.authed); nothing is left to sync.
      if (err instanceof ApiError && err.status === 401) state.value = 'idle';
      else state.value = code === 'offline' ? 'offline' : 'error';
      lastError.value = code === 'offline' ? null : code;
    }
  }

  async function applyResponse(sent: OutboxEntry[], res: SyncResponse, role: Role, initial: boolean) {
    await store.transaction('rw', responseTables(), async () => {
      const sentById = new Map(sent.map((e) => [e.op.opId, e]));
      // Answered ops (applied, clash or refused) leave the outbox; unanswered ones stay for next time.
      const answered = res.results.flatMap((r) => sentById.get(r.opId) ?? []);
      await store.outbox.bulkDelete(answered.map((e) => e.seq!));
      const stillPending = await store.outbox.orderBy('seq').toArray();
      const pendingFor = (entity: PullEntity, key: string) =>
        stillPending.filter((e) => e.op.entity === entity && e.op.entityId === key);

      for (const result of res.results) {
        const op = sentById.get(result.opId)?.op;
        if (!op || result.outcome === 'applied') continue;
        // Kept with what was entered, so a refused booking can be made again (nothing lost silently).
        await store.notices.put({
          opId: op.opId,
          kind: result.outcome,
          entity: op.entity,
          entityId: op.entityId,
          ...(result.outcome === 'clash' ? { winner: result.winner } : { reason: result.reason }),
          // Patient details are not kept on a notice (the patient may be, or be about to be,
          // erased: ADR 0007); booking fields are, so a refused booking can be made again.
          fields: op.entity === 'patients' ? {} : op.fields,
          at: now(),
        });
        if (result.outcome !== 'rejected') continue;
        // A refused create has no server row: remove the optimistic one (unless more is queued for it).
        const hasServerRow = (res.changes[op.entity] ?? []).some((r) => rowKey(op.entity, r) === op.entityId);
        if (!hasServerRow && pendingFor(op.entity, op.entityId).length === 0) {
          await store.entity(op.entity).delete(op.entityId);
        }
      }

      for (const entity of Object.keys(res.changes) as PullEntity[]) {
        const table = store.entity(entity);
        for (const serverRow of res.changes[entity] ?? []) {
          const key = rowKey(entity, serverRow);
          const local = (await table.get(key)) as AnyRow | undefined;
          // Never step back: a response that raced a newer one (another tab; later the service
          // worker) must not overwrite a row the device already holds at a higher version.
          if (local && !local.provisional && (local.version as number) > serverRow.version) continue;
          // A tombstone is kept as is (key + version + deletedAt; screens skip it), so the version
          // check above still works for late responses. Pending edits are not replayed onto it:
          // the server refuses them and they come back as notices. Notices about the deleted row
          // are dropped, so its details don't linger on the device.
          if (serverRow.deletedAt !== null) {
            await table.put({ ...serverRow, provisional: false } as never);
            await store.notices
              .filter(
                (n) =>
                  (n.entity === entity && n.entityId === key) ||
                  // A deleted patient's booking notices may hold their booking's note (ADR 0007).
                  (entity === 'patients' && n.fields.patientId === key),
              )
              .delete();
            continue;
          }
          // A clash or needs-fixing notice goes away once its booking is fixed.
          const status = (serverRow as { status?: string }).status;
          if (entity === 'bookings' && status !== 'clash' && status !== 'needs_fixing') {
            await store.notices.filter((n) => n.entityId === key && n.kind !== 'rejected').delete();
          }
          // Replay ops still waiting for the server, so a newer local edit is not overwritten.
          const row = pendingFor(entity, key).reduce<AnyRow>((r, e) => applyLocally(r, e.op, role), {
            ...serverRow,
            provisional: false,
          });
          await table.put(row as never);
        }
      }

      const cursor = (await store.getMeta<number>(CURSOR_KEY)) ?? 0;
      await store.setMeta(CURSOR_KEY, Math.max(cursor, res.newCursor));
      if (initial && !res.more) await store.setMeta(FILLED_KEY, true);
      if (res.retryOpsAfterMs) await store.setMeta(HOLD_OPS_KEY, now() + res.retryOpsAfterMs);
    });
    await refresh();
  }

  /** Keep syncing while the app is open: every 30 s, when back online and when shown (PRD §7.3). */
  function startAuto(
    target: Pick<Window, 'addEventListener' | 'removeEventListener'> & { document?: Document } = window,
  ) {
    const doc = target.document ?? document;
    const tick = () => {
      if (doc.visibilityState === 'visible') void syncNow();
    };
    const timer = setInterval(tick, AUTO_SYNC_EVERY_MS);
    target.addEventListener('online', tick);
    doc.addEventListener('visibilitychange', tick);
    void refresh();
    tick();
    return () => {
      clearInterval(timer);
      target.removeEventListener('online', tick);
      doc.removeEventListener('visibilitychange', tick);
    };
  }

  async function dismissNotice(opId: string) {
    await store.notices.delete(opId);
    await refresh();
  }

  return {
    state,
    lastSyncedAt,
    lastError,
    pendingCount,
    notices,
    write,
    syncNow,
    startAuto,
    dismissNotice,
    refresh,
  };
}

export type Sync = ReturnType<typeof createSync>;
export const sync = createSync();
