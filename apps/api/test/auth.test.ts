import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@yegna/shared';
import { admin } from '../src/routes/admin.ts';
import {
  type Call,
  PWA_ORIGIN,
  SETUP_CODE,
  addStaff,
  caller,
  createTestEnv,
  resetDb,
  setupDoctor,
} from './helpers.ts';

let env: Env;
let dispose: () => Promise<void>;
let call: Call;

beforeAll(async () => {
  ({ env, dispose } = await createTestEnv());
  call = caller(env);
});
afterAll(() => dispose());
beforeEach(() => resetDb(env));
afterEach(() => {
  vi.useRealTimers();
});

const setupBody = (over: Record<string, unknown> = {}) => ({
  code: SETUP_CODE,
  userId: uuidv7(),
  name: 'Dr. Selam',
  pin: '258014',
  deviceLabel: 'Doctor phone',
  ...over,
});
const enrol = (name: string, pin: string, ip?: string) =>
  call('POST', '/enrol', {
    body: { name, pin, deviceLabel: 'x' },
    ...(ip ? { headers: { 'CF-Connecting-IP': ip } } : {}),
  });

const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;

describe('first-doctor setup', () => {
  it('reports that setup is needed, then creates the doctor once', async () => {
    expect((await call('GET', '/setup')).json).toEqual({ needed: true });
    const res = await call('POST', '/setup', { body: setupBody() });
    expect(res.status).toBe(201);
    expect(res.json.user).toMatchObject({
      name: 'Dr. Selam',
      role: 'doctor',
      locale: 'am',
      calendar: 'ethiopian',
    });
    expect(res.json.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await call('GET', '/setup')).json).toEqual({ needed: false });
    expect((await call('POST', '/setup', { body: setupBody() })).json.error).toBe('already_set_up');
  });

  it('is disabled without a SETUP_CODE secret, or with one shorter than 32 characters', async () => {
    const { SETUP_CODE: _omit, ...noCode } = env;
    expect((await caller(noCode as Env)('POST', '/setup', { body: setupBody() })).status).toBe(503);
    const short = caller({ ...env, SETUP_CODE: 'short' });
    expect((await short('POST', '/setup', { body: setupBody({ code: 'short' }) })).status).toBe(503);
  });

  it('stays closed while any user row exists, even with no live doctor', async () => {
    const doctor = await setupDoctor(call);
    await env.DB.prepare('UPDATE users SET deleted_at = 1 WHERE id = ?').bind(doctor.user.id).run();
    expect((await call('GET', '/setup')).json).toEqual({ needed: false });
    expect((await call('POST', '/setup', { body: setupBody() })).json.error).toBe('already_set_up');
  });

  it('rejects a wrong code and locks after five tries', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await call('POST', '/setup', { body: setupBody({ code: 'wrong' }) })).status).toBe(401);
    }
    const locked = await call('POST', '/setup', { body: setupBody() });
    expect(locked.status).toBe(429);
    expect(locked.json.retryAfterMs).toBeGreaterThan(0);
  });

  it('rejects malformed input and trivial PINs without echoing them', async () => {
    for (const bad of [
      { pin: '12' },
      { pin: '1234567' },
      { pin: 'abcd' },
      { pin: '1234' },
      { pin: '0000' },
      { pin: '987654' },
      { pin: '2580' }, // the Doctor's PIN must be 6 digits
      { userId: 'not-a-uuid' },
      { name: '' },
    ]) {
      const res = await call('POST', '/setup', { body: setupBody(bad) });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'bad_request' });
    }
  });

  it('never stores the token or PIN in clear', async () => {
    const res = await setupDoctor(call);
    const device = await env.DB.prepare('SELECT token_hash FROM devices').first<{ token_hash: string }>();
    expect(device!.token_hash).not.toBe(res.token);
    const user = await env.DB.prepare('SELECT pin_hash FROM users').first<{ pin_hash: string }>();
    expect(user!.pin_hash).toMatch(/^pbkdf2-sha256\$\d+\$[0-9a-f]{64}$/);
    expect(JSON.stringify(res)).not.toContain('pbkdf2');
  });
});

describe('enrolment', () => {
  it('enrols staff by name + PIN, ignoring case and extra spaces', async () => {
    const doctor = await setupDoctor(call);
    await addStaff(call, doctor.token, 'Hana Bekele', '4731');
    const res = await enrol('  hana   BEKELE ', '4731');
    expect(res.status).toBe(201);
    expect(res.json.user).toMatchObject({ name: 'Hana Bekele', role: 'staff' });
  });

  it('also matches Ge’ez names', async () => {
    const doctor = await setupDoctor(call);
    await addStaff(call, doctor.token, 'ሐና በቀለ', '4731');
    expect((await enrol('ሐና  በቀለ', '4731')).status).toBe(201);
  });

  it('gives the same answer for a wrong PIN and an unknown name', async () => {
    const doctor = await setupDoctor(call);
    await addStaff(call, doctor.token, 'Hana', '4731');
    const wrongPin = await enrol('Hana', '0000');
    const unknown = await enrol('Nobody', '4731');
    expect(wrongPin.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPin.json).toEqual(unknown.json);
  });

  it('locks a name for five minutes after five wrong PINs, then unlocks', async () => {
    const doctor = await setupDoctor(call);
    await addStaff(call, doctor.token, 'Hana', '4731');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    for (let i = 0; i < 5; i++) expect((await enrol('Hana', '0000')).status).toBe(401);
    expect((await enrol('Hana', '4731')).status).toBe(429);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect((await enrol('Hana', '4731')).status).toBe(201);
    // A successful sign-in forgets the name's history.
    expect(
      await count("SELECT count(*) AS n FROM auth_attempts WHERE key LIKE 'enrol:%' AND key != 'enrol:all'"),
    ).toBe(0);
  });

  it('checks at most five PINs per round, even when guesses arrive at the same moment', async () => {
    const doctor = await setupDoctor(call);
    await addStaff(call, doctor.token, 'Hana', '4731');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => enrol('Hana', String(5000 + i), `10.0.0.${i}`)),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(15);
  });

  it('doubles each further lockout until a success', async () => {
    const doctor = await setupDoctor(call);
    await addStaff(call, doctor.token, 'Hana', '4731');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const round = async () => {
      for (let i = 0; i < 5; i++) await enrol('Hana', '0000', `10.1.0.${i}`);
    };
    await round(); // locked 5 min
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await round(); // locked 10 min
    vi.advanceTimersByTime(5 * 60_000 + 1);
    const stillLocked = await enrol('Hana', '4731', '10.1.1.1');
    expect(stillLocked.status).toBe(429);
    expect(stillLocked.json.retryAfterMs).toBeGreaterThan(4 * 60_000);
    vi.advanceTimersByTime(5 * 60_000);
    expect((await enrol('Hana', '4731', '10.1.1.1')).status).toBe(201);
  });

  it('limits one IP trying a PIN against many names', async () => {
    await setupDoctor(call);
    for (let i = 0; i < 10; i++) expect((await enrol(`Name ${i}`, '4731', '10.2.0.1')).status).toBe(401);
    expect((await enrol('Another name', '4731', '10.2.0.1')).status).toBe(429);
    expect((await enrol('Another name', '4731', '10.9.0.2')).status).toBe(401);
  });

  it('treats an IPv6 /64 as one client', async () => {
    await setupDoctor(call);
    for (let i = 0; i < 10; i++) await enrol(`Name ${i}`, '4731', `2001:db8:1:2::${i + 1}`);
    expect((await enrol('Another', '4731', '2001:db8:1:2:ffff::9')).status).toBe(429);
    expect((await enrol('Another', '4731', '2001:db8:1:3::1')).status).toBe(401);
  });

  it('a client spamming from a locked network cannot block anyone else', async () => {
    const doctor = await setupDoctor(call);
    await addStaff(call, doctor.token, 'Hana', '4731');
    for (let i = 0; i < 200; i++) await enrol(`Junk ${i}`, '0000', '10.7.0.1');
    // Refused attempts counted nothing, so a real person elsewhere signs in normally.
    expect((await enrol('Hana', '4731', '10.8.0.1')).status).toBe(201);
    // Only the 10 attempts before the network locked were counted at all.
    expect(await count("SELECT count(*) AS n FROM auth_attempts WHERE key LIKE 'enrol:%'")).toBe(10);
  });

  it('a success resets the network counter’s escalation', async () => {
    const doctor = await setupDoctor(call);
    await addStaff(call, doctor.token, 'Hana', '4731');
    for (let i = 0; i < 9; i++) await enrol(`Name ${i}`, '0000', '10.10.0.1');
    expect((await enrol('Hana', '4731', '10.10.0.1')).status).toBe(201); // 10th attempt: a success
    expect((await enrol('Hana', '4731', '10.10.0.1')).status).toBe(201); // not locked by its own success
    const row = await env.DB.prepare("SELECT locks FROM auth_attempts WHERE key LIKE 'ip:%'").first<{
      locks: number;
    }>();
    expect(row!.locks).toBe(0);
  });

  it('refuses a short PIN for the Doctor on reset, but allows it for Staff', async () => {
    const doctor = await setupDoctor(call);
    const staff = await addStaff(call, doctor.token, 'Hana', '4731');
    const self = await call('PATCH', `/admin/users/${doctor.user.id}`, {
      token: doctor.token,
      body: { pin: '6142' },
    });
    expect(self.status).toBe(400);
    const ok = await call('PATCH', `/admin/users/${doctor.user.id}`, {
      token: doctor.token,
      body: { pin: '614273' },
    });
    expect(ok.status).toBe(200);
    expect(
      (await call('PATCH', `/admin/users/${staff}`, { token: doctor.token, body: { pin: '6142' } })).status,
    ).toBe(200);
  });

  it('records lockouts in audit_log using hashes, not names or IPs', async () => {
    await setupDoctor(call);
    for (let i = 0; i < 5; i++) await enrol('Hana', '0000', '10.5.0.1');
    const rows = await env.DB.prepare("SELECT entity_id FROM audit_log WHERE action = 'lockout'").all<{
      entity_id: string;
    }>();
    expect(rows.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.results)).not.toMatch(/Hana|10\.5\.0\.1/);
  });

  it('a PIN reset by the Doctor lifts the lockout', async () => {
    const doctor = await setupDoctor(call);
    const id = await addStaff(call, doctor.token, 'Hana', '4731');
    for (let i = 0; i < 5; i++) await enrol('Hana', '0000', `10.6.0.${i}`);
    expect((await enrol('Hana', '4731', '10.6.1.1')).status).toBe(429);
    await call('PATCH', `/admin/users/${id}`, { token: doctor.token, body: { pin: '6142' } });
    expect((await enrol('Hana', '6142', '10.6.1.1')).status).toBe(201);
  });
});

describe('sessions, permissions and revocation', () => {
  it('authenticates with the device token', async () => {
    const doctor = await setupDoctor(call);
    const me = await call('GET', '/me', { token: doctor.token });
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ deviceId: doctor.deviceId, user: { role: 'doctor' } });
    expect((await call('GET', '/me')).status).toBe(401);
    expect((await call('GET', '/me', { token: 'f'.repeat(64) })).json.error).toBe('unauthorized');
    expect((await call('GET', '/me', { headers: { Authorization: 'Bearer short' } })).status).toBe(401);
  });

  it('lets a user change language and calendar, bumping the row version', async () => {
    const doctor = await setupDoctor(call);
    const before = await count('SELECT version AS n FROM users');
    const res = await call('PATCH', '/me', {
      token: doctor.token,
      body: { locale: 'en', calendar: 'gregorian' },
    });
    expect(res.json.user).toMatchObject({ locale: 'en', calendar: 'gregorian' });
    expect(await count('SELECT version AS n FROM users')).toBeGreaterThan(before);
    expect((await call('PATCH', '/me', { token: doctor.token, body: {} })).status).toBe(400);
  });

  it('keeps every /admin route doctor-only', async () => {
    const doctor = await setupDoctor(call);
    await addStaff(call, doctor.token, 'Hana', '4731');
    const staff = (await enrol('Hana', '4731')).json.token as string;
    const routes = admin.routes.filter((r) => r.method !== 'ALL');
    expect(routes.length).toBeGreaterThanOrEqual(5);
    for (const r of routes) {
      const path = `/admin${r.path.replace(':id', doctor.deviceId)}`;
      const body = r.method === 'GET' ? undefined : {};
      expect((await call(r.method, path, { token: staff, body })).status).toBe(403);
      expect((await call(r.method, path, { body })).status).toBe(401);
    }
  });

  it('requires unique active names, including when re-enabling', async () => {
    const doctor = await setupDoctor(call);
    const oldHana = await addStaff(call, doctor.token, 'Hana', '4731');
    const dup = await call('POST', '/admin/users', {
      token: doctor.token,
      body: { id: uuidv7(), name: ' HANA ', pin: '7302' },
    });
    expect(dup.json.error).toBe('name_taken');
    await call('PATCH', `/admin/users/${oldHana}`, { token: doctor.token, body: { disabled: true } });
    await addStaff(call, doctor.token, 'Hana', '7302');
    const reenable = await call('PATCH', `/admin/users/${oldHana}`, {
      token: doctor.token,
      body: { disabled: false },
    });
    expect(reenable.json.error).toBe('name_taken');
  });

  it('answers 409, not 500, when a user id is reused', async () => {
    const doctor = await setupDoctor(call);
    const id = await addStaff(call, doctor.token, 'Hana', '4731');
    const again = await call('POST', '/admin/users', {
      token: doctor.token,
      body: { id, name: 'Other', pin: '7302' },
    });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('conflict');
  });

  it('lists devices and revokes one; the revoked device is told to wipe', async () => {
    const doctor = await setupDoctor(call);
    await addStaff(call, doctor.token, 'Hana', '4731');
    const staff = await call('POST', '/enrol', {
      body: { name: 'Hana', pin: '4731', deviceLabel: 'Front desk' },
    });
    const list = await call('GET', '/admin/devices', { token: doctor.token });
    expect((list.json as unknown as { label: string }[]).map((d) => d.label).sort()).toEqual([
      'Doctor phone',
      'Front desk',
    ]);
    const path = `/admin/devices/${staff.json.deviceId}/revoke`;
    expect((await call('POST', path, { token: doctor.token })).status).toBe(200);
    expect((await call('GET', '/me', { token: staff.json.token as string })).json.error).toBe('revoked');
    // Revoking again is harmless; revoking your own device is refused.
    expect((await call('POST', path, { token: doctor.token })).status).toBe(200);
    const own = await call('POST', `/admin/devices/${doctor.deviceId}/revoke`, { token: doctor.token });
    expect(own.status).toBe(400);
    expect((await call('POST', `/admin/devices/${uuidv7()}/revoke`, { token: doctor.token })).status).toBe(
      404,
    );
  });

  it('disabling a user revokes their devices and blocks enrolment; re-enabling allows it again', async () => {
    const doctor = await setupDoctor(call);
    const id = await addStaff(call, doctor.token, 'Hana', '4731');
    const staff = await enrol('Hana', '4731');
    await call('PATCH', `/admin/users/${id}`, { token: doctor.token, body: { disabled: true } });
    expect((await call('GET', '/me', { token: staff.json.token as string })).json.error).toBe('revoked');
    expect((await enrol('Hana', '4731')).status).toBe(401);
    await call('PATCH', `/admin/users/${id}`, {
      token: doctor.token,
      body: { disabled: false, pin: '9182' },
    });
    expect((await enrol('Hana', '9182')).status).toBe(201);
    const self = await call('PATCH', `/admin/users/${doctor.user.id}`, {
      token: doctor.token,
      body: { disabled: true },
    });
    expect(self.status).toBe(400);
    const missing = await call('PATCH', `/admin/users/${uuidv7()}`, {
      token: doctor.token,
      body: { name: 'X' },
    });
    expect(missing.status).toBe(404);
  });

  it('writes audit_log without PIN hashes or PINs', async () => {
    const doctor = await setupDoctor(call);
    const id = await addStaff(call, doctor.token, 'Hana', '4731');
    await call('PATCH', `/admin/users/${id}`, { token: doctor.token, body: { pin: '5826' } });
    const rows = await env.DB.prepare('SELECT action, diff FROM audit_log ORDER BY at').all<{
      action: string;
      diff: string;
    }>();
    expect(rows.results.map((r) => r.action)).toEqual(['setup', 'create', 'update']);
    expect(rows.results.map((r) => r.diff).join(' ')).not.toMatch(/pbkdf2|5826/);
  });
});

describe('CORS and configuration', () => {
  it('allows only the PWA origin', async () => {
    const ok = await call('OPTIONS', '/me', {
      headers: { Origin: PWA_ORIGIN, 'Access-Control-Request-Method': 'GET' },
    });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(PWA_ORIGIN);
    const other = await call('GET', '/health', { headers: { Origin: 'https://evil.example' } });
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('refuses to run a deployed environment that trusts localhost', async () => {
    const res = await caller({ ...env, ENVIRONMENT: 'staging' })('GET', '/health');
    expect(res.status).toBe(500);
  });
});
