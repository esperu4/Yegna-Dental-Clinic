/**
 * Language and calendar preferences (PRD §3, §8; switches on every screen, decided 2026-11-10).
 * A change applies on the device at once, works offline, and is saved to the user's account in the
 * background; if the device is offline it is sent later (`flush`).
 */
import type { CalendarPref, Locale, SessionUser } from '@yegna/shared/client';
import { ApiError } from './api.ts';
import { db as defaultDb, type YegnaDb } from './db.ts';
import { session as defaultSession, type Session } from './session.ts';

export type PreferencePatch = { locale?: Locale; calendar?: CalendarPref };

const PENDING_KEY = 'pendingPreferences';

export function createPreferences(deps: { db?: YegnaDb; session?: Session } = {}) {
  const store = deps.db ?? defaultDb;
  const auth = deps.session ?? defaultSession;

  // Saves run one after another, in the order the user made them: two quick taps must not reach
  // the server in reverse order and leave the account on the older choice.
  let queue: Promise<void> = Promise.resolve();
  function inOrder(task: () => Promise<void>): Promise<void> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function send(patch: PreferencePatch): Promise<boolean> {
    try {
      // The device already shows the choice; the answer is not applied, so a slow answer to an
      // older save can't undo a newer one.
      await auth.authed<{ user: SessionUser }>('/me', { method: 'PATCH', body: patch });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'offline') return false;
      throw err;
    }
  }

  /**
   * Apply now on this device and save to the account. The change is written to the device first
   * and removed only once the server has it, so closing or reloading the app mid-save loses
   * nothing: `flush` sends it at the next start.
   */
  async function set(patch: PreferencePatch): Promise<void> {
    const current = auth.current.value;
    if (!current) return;
    await auth.updateUser({ ...current.user, ...patch });
    await store.setMeta(PENDING_KEY, { ...(await store.getMeta<PreferencePatch>(PENDING_KEY)), ...patch });
    await flush();
  }

  /** Send the change not yet saved to the account (after a change, on start, back online). */
  function flush(): Promise<void> {
    return inOrder(async () => {
      const pending = await store.getMeta<PreferencePatch>(PENDING_KEY);
      if (!pending || !auth.current.value) return;
      try {
        if (!(await send(pending))) return; // offline: kept for later
      } catch (err) {
        // A refused change (4xx: e.g. signed out meanwhile) is dropped; the account keeps its
        // value. A server error keeps it for the next try.
        if (!(err instanceof ApiError && err.status >= 400 && err.status < 500)) return;
      }
      // Remove it only if no newer change arrived meanwhile (that one is sent next).
      const now = await store.getMeta<PreferencePatch>(PENDING_KEY);
      if (JSON.stringify(now) === JSON.stringify(pending)) await store.meta.delete(PENDING_KEY);
    });
  }

  return { set, flush };
}

export const preferences = createPreferences();
