/**
 * `POST /sync` (PRD §7.4): apply the device's ops in order, then return every change since its
 * cursor. A revoked device gets `401 revoked` from `requireDevice` and wipes itself (PRD §7.9).
 *
 * Stays inside the D1 per-invocation query limit: ops are applied only while the remaining
 * budget covers the worst case for one more op plus the pull. Unanswered ops stay in the
 * device's outbox and come back in its next call (the response answers a prefix of the ops).
 * A device past its daily op budget gets no new ops applied but still pulls (`retryOpsAfterMs`).
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  DEVICE_DAILY_OPS,
  type OpResult,
  type PullEntity,
  type SyncResponse,
  syncRequestSchema,
} from '@yegna/shared';
import { utcToLocal } from '@yegna/time';
import { type AppEnv, fail, parseBody } from '../lib/http.ts';
import { requireDevice } from '../lib/session.ts';
import { patientCancellations, patientConfirmations } from '../jobs/patient.ts';
import { clashAlerts, linkedTeam } from '../jobs/team.ts';
import { telegramNotifier } from '../notify/notifier.ts';
import { MAX_QUERIES_PER_OP, applyOp, prefetch } from '../sync/apply.ts';
import { currentRows, mergeChanges, pull } from '../sync/pull.ts';

/** 200 ops of a few hundred bytes each, with room to spare. */
const MAX_BODY_BYTES = 512 * 1024;
/** Queries kept back for the pull and the rows sent back for refused ops. */
const PULL_RESERVE = 2;
/** Queries a clash alert needs at least (team, bookings, one delivery). */
const CLASH_ALERT_MIN_QUERIES = 6;
/** Queries patient messages need at least (two reads, one delivery). */
const PATIENT_MESSAGE_MIN_QUERIES = 6;
const DAY_MS = 86_400_000;
/** A throttled device sends only pulls for this long, then tries its ops again. */
const THROTTLE_RETRY_MS = 60 * 60_000;

export const sync = new Hono<AppEnv>();

sync.post(
  '/',
  bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, 413, 'bad_request') }),
  requireDevice,
  async (c) => {
    const body = await parseBody(c, syncRequestSchema);
    if (!body) return fail(c, 400, 'bad_request');
    const db = c.get('db');
    const meter = c.get('meter');
    const session = c.get('session');
    if (body.deviceId !== session.deviceId) return fail(c, 403, 'forbidden');

    const results: OpResult[] = [];
    let throttled = false;
    if (body.ops.length) {
      const now = Date.now();
      const { stored, opsSince } = await prefetch(
        db,
        session.deviceId,
        body.ops.map((o) => o.opId),
        now - DAY_MS,
      );
      // Over the daily budget: answer only ops already applied, hold the rest, and still pull,
      // so the device keeps an up-to-date schedule while it waits.
      throttled = opsSince >= DEVICE_DAILY_OPS;

      // In order: a later op may depend on an earlier one (create a patient, then book them).
      for (const op of body.ops) {
        const known = stored.get(op.opId);
        if (known) {
          results.push(known);
          continue;
        }
        if (throttled || meter.remaining() < MAX_QUERIES_PER_OP + PULL_RESERVE) break;
        const result = await applyOp({ db, session, now: Date.now() }, op);
        if (!result) break;
        results.push(result);
      }
    }

    const page = await pull(db, body.cursor, Date.now(), { initial: body.initial === true });
    // For refused ops, send the server's current row so the device can undo its optimistic copy.
    const refused = body.ops
      .slice(0, results.length)
      .filter((_, i) => results[i]!.outcome === 'rejected')
      .map((op) => ({ entity: op.entity as PullEntity, key: op.entityId }));
    const changes = refused.length
      ? mergeChanges(page.changes, await currentRows(db, refused))
      : page.changes;

    // After the response, one after the other within what is left of this request's query budget
    // (so two senders never overspend it together); the hourly run sends whatever does not fit.
    const applied = (outcome: OpResult['outcome']) =>
      body.ops.slice(0, results.length).filter((_, i) => results[i]!.outcome === outcome);
    // Clash alerts to the creator and the Doctor (PRD §13 "on sync").
    const clashed = applied('clash').map((op) => op.entityId);
    // Patient confirmations and cancellation notices (PRD §14) for bookings this sync changed;
    // only approved (or told-then-cancelled) bookings qualify, see jobs/patient.ts.
    const touched = applied('applied')
      .filter((op) => op.entity === 'bookings')
      .map((op) => op.entityId);
    const teamToken = c.env.TEAM_BOT_TOKEN;
    const patientToken = c.env.PATIENT_BOT_TOKEN;
    const now = Date.now();
    const after = async () => {
      if (clashed.length && teamToken && meter.remaining() >= CLASH_ALERT_MIN_QUERIES) {
        const team = await linkedTeam(db);
        await clashAlerts(
          { db, meter, notifier: telegramNotifier(teamToken), now, pwaUrl: c.env.PWA_ORIGIN },
          team,
          clashed,
        );
      }
      if (touched.length && patientToken && meter.remaining() >= PATIENT_MESSAGE_MIN_QUERIES) {
        const ctx = { db, meter, notifier: telegramNotifier(patientToken), now, local: utcToLocal(now) };
        await patientConfirmations(ctx, touched);
        await patientCancellations(ctx, touched);
      }
    };
    if ((clashed.length && teamToken) || (touched.length && patientToken)) {
      const send = after().catch((err: unknown) =>
        console.error('after_sync_messages_failed', err instanceof Error ? err.name : 'unknown'),
      );
      try {
        c.executionCtx.waitUntil(send);
      } catch {
        // No execution context (tests calling the app directly): it runs on its own.
      }
    }

    return c.json({
      results,
      changes,
      newCursor: page.newCursor,
      more: page.more,
      ...(throttled ? { retryOpsAfterMs: THROTTLE_RETRY_MS } : {}),
    } satisfies SyncResponse);
  },
);
