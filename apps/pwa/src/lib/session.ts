/**
 * Device session (PRD §8 item 1, §7.9):
 * - enrol or set up online, keep the device token on the device;
 * - lock after 24 h without use; unlock with the PIN, checked on the device (works offline);
 * - five wrong PINs ⇒ five-minute local lockout;
 * - `401 revoked` from the server ⇒ wipe everything and return to enrolment.
 */
import { signal } from '@preact/signals';
import type { EnrolResponse, SessionUser, SetupRequest, EnrolRequest } from '@yegna/shared/client';
import { uuidv7 } from '@yegna/shared/client';
import { calendarPref, locale } from '../i18n/index.ts';
import { ApiError, type ApiOptions, api } from './api.ts';
import { type YegnaDb, db as defaultDb } from './db.ts';
import { type PinVerifier, checkVerifier, makeVerifier } from './pin.ts';

export const INACTIVITY_LOCK_MS = 24 * 60 * 60_000;
export const LOCAL_MAX_FAILURES = 5;
export const LOCAL_LOCKOUT_MS = 5 * 60_000;
/** Don't write "last active" more often than this. */
const TOUCH_EVERY_MS = 60_000;

export interface StoredSession {
  token: string;
  deviceId: string;
  user: SessionUser;
}

interface LocalLock {
  failures: number;
  lockedUntil: number | null;
}

export type AuthStatus = 'loading' | 'signedOut' | 'locked' | 'ready';

export type UnlockResult =
  | { ok: true }
  | { ok: false; reason: 'wrong'; left: number }
  | { ok: false; reason: 'locked'; retryAfterMs: number };

export function createSession(deps: { db?: YegnaDb; fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const store = deps.db ?? defaultDb;
  const now = deps.now ?? Date.now;
  const status = signal<AuthStatus>('loading');
  const current = signal<StoredSession | null>(null);
  /** Shown once on the enrolment screen after a remote sign-out. */
  const notice = signal<'revoked' | null>(null);
  let lastTouch = 0;
  // A wipe in another context (the service worker after a 401) signs this one out too.
  // One channel per device store: the page and the service worker share the store 'yegna'.
  const channel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`${SESSION_CHANNEL}:${store.name}`);
  if (channel) {
    channel.onmessage = (event: MessageEvent<SessionMessage>) => {
      if (event.data?.type === 'wiped' && current.value) signedOutHere(event.data.reason);
    };
  }

  function applyPrefs(user: SessionUser) {
    locale.value = user.locale;
    calendarPref.value = user.calendar;
  }

  /**
   * Loads the session stored on the device. The page counts this as use (it opened); the service
   * worker passes `{ use: false }` and re-reads before every run, so a background sync never keeps
   * the 24 h lock away (PRD §8) and never acts on a session the page has since replaced.
   */
  async function init({ use = true }: { use?: boolean } = {}): Promise<void> {
    const saved = await store.getMeta<StoredSession>('session');
    if (!saved) {
      current.value = null;
      status.value = 'signedOut';
      return;
    }
    current.value = saved;
    applyPrefs(saved.user);
    const lastActive = (await store.getMeta<number>('lastActiveAt')) ?? 0;
    status.value = now() - lastActive > INACTIVITY_LOCK_MS ? 'locked' : 'ready';
    if (use && status.value === 'ready') await touch(true);
  }

  async function start(res: EnrolResponse, pin: string): Promise<void> {
    const verifier = await makeVerifier(pin);
    await store.transaction('rw', store.meta, async () => {
      await store.setMeta('session', res satisfies StoredSession);
      await store.setMeta('pinVerifier', verifier);
      await store.setMeta('localLock', { failures: 0, lockedUntil: null } satisfies LocalLock);
      await store.setMeta('lastActiveAt', now());
    });
    current.value = res;
    applyPrefs(res.user);
    notice.value = null;
    status.value = 'ready';
  }

  const call = <T>(path: string, opts: ApiOptions = {}) =>
    api<T>(path, { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...opts });

  async function setup(input: Omit<SetupRequest, 'userId'>): Promise<void> {
    const res = await call<EnrolResponse>('/setup', { body: { ...input, userId: uuidv7() } });
    await start(res, input.pin);
  }

  async function enrol(input: EnrolRequest): Promise<void> {
    const res = await call<EnrolResponse>('/enrol', { body: input });
    await start(res, input.pin);
  }

  async function unlock(pin: string): Promise<UnlockResult> {
    const lock = (await store.getMeta<LocalLock>('localLock')) ?? { failures: 0, lockedUntil: null };
    const t = now();
    if (lock.lockedUntil && lock.lockedUntil > t)
      return { ok: false, reason: 'locked', retryAfterMs: lock.lockedUntil - t };
    const verifier = await store.getMeta<PinVerifier>('pinVerifier');
    if (verifier && (await checkVerifier(pin, verifier))) {
      await store.setMeta('localLock', { failures: 0, lockedUntil: null } satisfies LocalLock);
      status.value = 'ready';
      await touch(true);
      return { ok: true };
    }
    const failures = (lock.lockedUntil && lock.lockedUntil <= t ? 0 : lock.failures) + 1;
    if (failures >= LOCAL_MAX_FAILURES) {
      await store.setMeta('localLock', {
        failures: 0,
        lockedUntil: t + LOCAL_LOCKOUT_MS,
      } satisfies LocalLock);
      return { ok: false, reason: 'locked', retryAfterMs: LOCAL_LOCKOUT_MS };
    }
    await store.setMeta('localLock', { failures, lockedUntil: null } satisfies LocalLock);
    return { ok: false, reason: 'wrong', left: LOCAL_MAX_FAILURES - failures };
  }

  /** Record use. Call on interactions; writes at most once a minute. */
  async function touch(force = false): Promise<void> {
    const t = now();
    if (!force && t - lastTouch < TOUCH_EVERY_MS) return;
    lastTouch = t;
    await store.setMeta('lastActiveAt', t);
  }

  /** Lock if the device has been idle for 24 h (call when the app becomes visible). */
  async function checkIdle(): Promise<void> {
    if (status.value !== 'ready') return;
    const lastActive = (await store.getMeta<number>('lastActiveAt')) ?? 0;
    if (now() - lastActive > INACTIVITY_LOCK_MS) status.value = 'locked';
  }

  /** Remove everything this app keeps on the device, and tell other contexts (page ⇄ service worker). */
  async function wipe(reason: 'revoked' | null = null): Promise<void> {
    await store.transaction('rw', store.tables, async () => {
      await Promise.all(store.tables.map((t) => t.clear()));
    });
    signedOutHere(reason);
    channel?.postMessage({ type: 'wiped', reason } satisfies SessionMessage);
  }

  function signedOutHere(reason: 'revoked' | null) {
    current.value = null;
    status.value = 'signedOut';
    notice.value = reason;
  }

  /**
   * Authenticated API call. A 401 wipes the device (PRD §7.9), but only if the token that was
   * refused is still the one stored: a page or service worker holding an older session must never
   * wipe a newer enrolment.
   */
  async function authed<T>(path: string, opts: Omit<ApiOptions, 'token'> = {}): Promise<T> {
    const token = current.value?.token ?? null;
    try {
      return await call<T>(path, { ...opts, token });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        const stored = await store.getMeta<StoredSession>('session');
        if (stored && stored.token === token) await wipe(err.code === 'revoked' ? 'revoked' : null);
        else if (!stored) signedOutHere(null);
      }
      throw err;
    }
  }

  async function updateUser(user: SessionUser): Promise<void> {
    if (!current.value) return;
    current.value = { ...current.value, user };
    applyPrefs(user);
    await store.setMeta('session', current.value);
  }

  return { status, current, notice, init, setup, enrol, unlock, touch, checkIdle, wipe, authed, updateUser };
}

export type Session = ReturnType<typeof createSession>;

const SESSION_CHANNEL = 'yegna-session';
type SessionMessage = { type: 'wiped'; reason: 'revoked' | null };
export const session = createSession();
