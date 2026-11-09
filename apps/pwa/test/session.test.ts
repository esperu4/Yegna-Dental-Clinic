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
  });

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
