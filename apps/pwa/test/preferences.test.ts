import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { calendarPref, locale } from '../src/i18n/index.ts';
import { YegnaDb } from '../src/lib/db.ts';
import { createPreferences } from '../src/lib/preferences.ts';
import { createSession } from '../src/lib/session.ts';

const user = {
  id: 'u1',
  name: 'Hana',
  role: 'staff' as const,
  locale: 'am' as const,
  calendar: 'ethiopian' as const,
};

let n = 0;
async function setup() {
  const server = { offline: false, patches: [] as unknown[] };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (server.offline) throw new TypeError('Failed to fetch');
    const path = new URL(url).pathname;
    if (path === '/enrol') return json({ token: 'a'.repeat(64), deviceId: 'd1', user });
    const patch = JSON.parse(init.body as string);
    server.patches.push(patch);
    return json({ deviceId: 'd1', user: { ...user, ...patch } });
  }) as unknown as typeof fetch;
  const db = new YegnaDb(`prefs-${n++}`);
  const session = createSession({ db, fetchImpl });
  await session.enrol({ name: 'Hana', pin: '4731', deviceLabel: 'x' });
  return { server, db, session, prefs: createPreferences({ db, session }) };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('preferences', () => {
  it('applies a switch at once and saves it to the account', async () => {
    const { server, prefs, session } = await setup();
    await prefs.set({ locale: 'en' });
    expect(locale.value).toBe('en');
    expect(session.current.value?.user.locale).toBe('en');
    expect(server.patches).toEqual([{ locale: 'en' }]);
  });

  it('works offline and sends the change once back online', async () => {
    const { server, prefs, db } = await setup();
    server.offline = true;
    await prefs.set({ calendar: 'gregorian' });
    await prefs.set({ locale: 'en' });
    expect(calendarPref.value).toBe('gregorian');
    expect(await db.getMeta('pendingPreferences')).toEqual({ calendar: 'gregorian', locale: 'en' });
    server.offline = false;
    await prefs.flush();
    expect(server.patches).toEqual([{ calendar: 'gregorian', locale: 'en' }]);
    expect(await db.getMeta('pendingPreferences')).toBeUndefined();
  });
});
