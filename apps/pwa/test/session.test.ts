import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { YegnaDb } from '../src/lib/db.ts';
import { INACTIVITY_LOCK_MS, LOCAL_LOCKOUT_MS, createSession } from '../src/lib/session.ts';
import { locale } from '../src/i18n/index.ts';

const user = {
  id: 'u1',
  name: 'Hana',
  role: 'staff' as const,
  locale: 'en' as const,
  calendar: 'gregorian' as const,
};
const enrolled = { token: 'a'.repeat(64), deviceId: 'd1', user };

function fakeFetch(handler: (path: string, init: RequestInit) => { status: number; body: unknown }) {
  return (async (url: string, init: RequestInit) => {
    const { status, body } = handler(new URL(url).pathname, init);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

let clock = 1_800_000_000_000;
let n = 0;
type Handler = (path: string, init: RequestInit) => { status: number; body: unknown };
const make = (handler: Handler = () => ({ status: 201, body: enrolled })) =>
  createSession({ db: new YegnaDb(`test-${n++}`), fetchImpl: fakeFetch(handler), now: () => clock });

beforeEach(() => {
  clock = 1_800_000_000_000;
});

describe('device session', () => {
  it('starts signed out, enrols, and applies the user’s language', async () => {
    const s = make();
    await s.init();
    expect(s.status.value).toBe('signedOut');
    await s.enrol({ name: 'Hana', pin: '4731', deviceLabel: 'Front desk' });
    expect(s.status.value).toBe('ready');
    expect(s.current.value?.deviceId).toBe('d1');
    expect(locale.value).toBe('en');
  });

  it('survives a restart, and locks after 24 h without use', async () => {
    const dbName = new YegnaDb(`restart-${n++}`);
    const fetchImpl = fakeFetch(() => ({ status: 201, body: enrolled }));
    const a = createSession({ db: dbName, fetchImpl, now: () => clock });
    await a.enrol({ name: 'Hana', pin: '4731', deviceLabel: 'x' });

    clock += INACTIVITY_LOCK_MS - 1000;
    const b = createSession({ db: dbName, fetchImpl, now: () => clock });
    await b.init();
    expect(b.status.value).toBe('ready');

    clock += INACTIVITY_LOCK_MS + 1;
    const c = createSession({ db: dbName, fetchImpl, now: () => clock });
    await c.init();
    expect(c.status.value).toBe('locked');
    expect(await c.unlock('4731')).toEqual({ ok: true });
    expect(c.status.value).toBe('ready');
  });

  // Each wrong PIN runs the deliberately slow PIN hash: allow for a loaded machine.
  it('unlocks offline with the PIN; five wrong PINs lock for five minutes', async () => {
    const s = make();
    await s.enrol({ name: 'Hana', pin: '4731', deviceLabel: 'x' });
    s.status.value = 'locked';
    for (let left = 4; left >= 1; left--)
      expect(await s.unlock('0000')).toEqual({ ok: false, reason: 'wrong', left });
    expect(await s.unlock('0000')).toMatchObject({ ok: false, reason: 'locked' });
    expect(await s.unlock('4731')).toMatchObject({ ok: false, reason: 'locked' });
    clock += LOCAL_LOCKOUT_MS + 1;
    expect(await s.unlock('4731')).toEqual({ ok: true });
  }, 20_000);

  it('checkIdle locks a running app that has been idle for 24 h', async () => {
    const s = make();
    await s.enrol({ name: 'Hana', pin: '4731', deviceLabel: 'x' });
    clock += INACTIVITY_LOCK_MS + 1;
    await s.checkIdle();
    expect(s.status.value).toBe('locked');
  });

  it('wipes the device when the server says revoked', async () => {
    const s = make((path) =>
      path === '/enrol' ? { status: 201, body: enrolled } : { status: 401, body: { error: 'revoked' } },
    );
    await s.enrol({ name: 'Hana', pin: '4731', deviceLabel: 'x' });
    await expect(s.authed('/me')).rejects.toMatchObject({ code: 'revoked' });
    expect(s.status.value).toBe('signedOut');
    expect(s.notice.value).toBe('revoked');
    await s.init();
    expect(s.status.value).toBe('signedOut');
  });

  it('never lets a refused older token wipe a newer enrolment (page and service worker)', async () => {
    const db = new YegnaDb(`stale-${n++}`);
    let token = 'a'.repeat(64);
    const fetchImpl = fakeFetch((path, init) => {
      if (path === '/enrol') return { status: 201, body: { ...enrolled, token } };
      const sent = (init.headers as Record<string, string>).Authorization;
      return sent === `Bearer ${'a'.repeat(64)}`
        ? { status: 401, body: { error: 'revoked' } }
        : { status: 200, body: {} };
    });
    const old = createSession({ db, fetchImpl, now: () => clock });
    await old.enrol({ name: 'Hana', pin: '4731', deviceLabel: 'x' });
    // The device is enrolled again (new token) while `old` still holds the first session.
    token = 'b'.repeat(64);
    const fresh = createSession({ db, fetchImpl, now: () => clock });
    await fresh.enrol({ name: 'Hana', pin: '4731', deviceLabel: 'x' });
    await expect(old.authed('/me')).rejects.toMatchObject({ code: 'revoked' });
    expect(await db.getMeta('session')).toMatchObject({ token: 'b'.repeat(64) });
  });

  it('a wipe in one context signs the others out (service worker → page)', async () => {
    const db = new YegnaDb(`broadcast-${n++}`);
    const fetchImpl = fakeFetch(() => ({ status: 201, body: enrolled }));
    const page = createSession({ db, fetchImpl, now: () => clock });
    await page.enrol({ name: 'Hana', pin: '4731', deviceLabel: 'x' });
    const worker = createSession({ db, fetchImpl, now: () => clock });
    await worker.init({ use: false });
    await worker.wipe('revoked');
    await expect.poll(() => page.status.value).toBe('signedOut');
    expect(page.notice.value).toBe('revoked');
  });

  it('a service-worker read does not count as use (the 24 h lock still comes)', async () => {
    const db = new YegnaDb(`nouse-${n++}`);
    const fetchImpl = fakeFetch(() => ({ status: 201, body: enrolled }));
    const page = createSession({ db, fetchImpl, now: () => clock });
    await page.enrol({ name: 'Hana', pin: '4731', deviceLabel: 'x' });
    const before = await db.getMeta('lastActiveAt');
    clock += 60 * 60_000;
    await createSession({ db, fetchImpl, now: () => clock }).init({ use: false });
    expect(await db.getMeta('lastActiveAt')).toBe(before);
  });

  it('reports a network failure as offline', async () => {
    const s = createSession({
      db: new YegnaDb(`offline-${n++}`),
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
      now: () => clock,
    });
    await expect(s.enrol({ name: 'Hana', pin: '4731', deviceLabel: 'x' })).rejects.toMatchObject({
      code: 'offline',
    });
    expect(s.status.value).not.toBe('ready');
  });
});
