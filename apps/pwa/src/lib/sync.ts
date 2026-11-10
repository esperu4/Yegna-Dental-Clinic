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
import { showSyncNotification } from './syncNotification.ts';
import { SummaryBuilder, type SyncSummary, somethingHappened } from './syncStatus.ts';
import { type Session, session as defaultSession } from './session.ts';

export const AUTO_SYNC_EVERY_MS = 30_000;
/** Upper bound on request rounds in one `syncNow` (outbox pages + pull pages). */
const MAX_ROUNDS = 50;
const CURSOR_KEY = 'syncCursor';
/** Set once the first full pull has finished (until then the server applies the booking window). */
const FILLED_KEY = 'syncFilled';
/** Until this time the device only pulls: the server held its ops back (daily budget). */
const HOLD_OPS_KEY = 'syncHoldOpsUntil';
/** When this device last finished a sync (survives reopening the app). */
const LAST_SYNC_KEY = 'syncLastAt';
/** Notices older than this are dropped, so entered patient details don't linger (PRD §18). */
export const NOTICE_TTL_MS = 30 * 86_400_000;

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

type AnyRow = Record<string, unknown>;

export function createSync(
  deps: {
    db?: YegnaDb;
    session?: Session;
    now?: () => number;
    /** Called after a sync run in which something happened (PRD §7.7: the sync notification). */
    onSummary?: (summary: SyncSummary) => void;
  } = {},
) {
  const store = deps.db ?? defaultDb;
  const auth = deps.session ?? defaultSession;
  const now = deps.now ?? Date.now;

  const state = signal<SyncState>('idle');
  const lastSyncedAt = signal<number | null>(null);
  const lastError = signal<string | null>(null);
  /** When the device last went from online to offline; null while online (PRD §7.6). */
  const offlineSince = signal<number | null>(null);
  const pendingCount = signal(0);
  /** Until when the server holds this device's ops back (daily budget); null if not held. */
  const heldUntil = signal<number | null>(null);
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
    lastSyncedAt.value ??= (await store.getMeta<number>(LAST_SYNC_KEY)) ?? null;
    const held = (await store.getMeta<number>(HOLD_OPS_KEY)) ?? 0;
    heldUntil.value = held > now() ? held : null;
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
    const summary = new SummaryBuilder();
    const report = () => {
      // A notification problem must never turn a good sync into a failed one.
      try {
        if (somethingHappened(summary.summary)) deps.onSummary?.(summary.summary);
      } catch {
        /* ignore */
      }
    };
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const holdOps = ((await store.getMeta<number>(HOLD_OPS_KEY)) ?? 0) > now();
        const entries = holdOps ? [] : await store.outbox.orderBy('seq').limit(MAX_OPS_PER_SYNC).toArray();
        const cursor = (await store.getMeta<number>(CURSOR_KEY)) ?? 0;
        const initial = !(await store.getMeta<boolean>(FILLED_KEY));
        const res = await auth.authed<SyncResponse>('/sync', {
          body: { deviceId: signedIn.deviceId, cursor, initial, ops: entries.map((e) => e.op) },
        });
        const newFromOthers = await applyResponse(entries, res, signedIn.user, initial);
        summary.add({
          results: res.results,
          sent: new Map(entries.map((e) => [e.op.opId, { entity: e.op.entity, entityId: e.op.entityId }])),
          newFromOthers,
        });
        if (!res.more && (holdOps || res.retryOpsAfterMs || (await store.outbox.count()) === 0)) break;
        // The server answered none of our ops this time (it ran out of budget): try again later.
        if (!res.more && entries.length > 0 && res.results.length === 0) break;
      }
      lastError.value = null;
      // The network may have dropped while the last response was arriving: then stay offline.
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      state.value = online ? 'idle' : 'offline';
      if (online) offlineSince.value = null;
      lastSyncedAt.value = now();
      await store.setMeta(LAST_SYNC_KEY, lastSyncedAt.value);
      report();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'server_error';
      // A 401 has already wiped the device (session.authed); nothing is left to sync.
      if (err instanceof ApiError && err.status === 401) state.value = 'idle';
      else state.value = code === 'offline' ? 'offline' : 'error';
      // Any answer from the server proves the phone was online.
      if (code === 'offline') offlineSince.value ??= now();
      else offlineSince.value = null;
      lastError.value = code === 'offline' || state.value === 'idle' ? null : code;
      // Earlier rounds of this run may have been applied already: still tell the user.
      report();
    }
  }

  /**
   * Applies one response in one transaction. Returns the bookings that are new on this device and
   * were made by someone else, by user id (for the notification; never during the first fill).
   */
  async function applyResponse(
    sent: OutboxEntry[],
    res: SyncResponse,
    user: { id: string; role: Role },
    initial: boolean,
  ): Promise<Record<string, number>> {
    const role = user.role;
    const newFromOthers: Record<string, number> = {};
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
          const createdBy = (serverRow as { createdBy?: string }).createdBy;
          if (entity === 'bookings' && !local && !initial && createdBy && createdBy !== user.id) {
            newFromOthers[createdBy] = (newFromOthers[createdBy] ?? 0) + 1;
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
    return newFromOthers;
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
    // Going offline shows at once in the pill, before any sync fails (PRD §7.6).
    const wentOffline = () => {
      offlineSince.value ??= now();
      state.value = 'offline';
    };
    target.addEventListener('online', tick);
    target.addEventListener('offline', wentOffline);
    doc.addEventListener('visibilitychange', tick);
    void refresh();
    tick();
    return () => {
      clearInterval(timer);
      target.removeEventListener('online', tick);
      target.removeEventListener('offline', wentOffline);
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
    offlineSince,
    heldUntil,
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
export const sync = createSync({ onSummary: (summary) => void showSyncNotification(summary) });
