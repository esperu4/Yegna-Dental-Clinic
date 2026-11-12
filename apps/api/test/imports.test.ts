/**
 * Reading imports (PRD §12, ADR 0009): photo from Telegram, reader chain, matching by phone and
 * by name, duplicates within ±30 minutes, failures, and one reading at a time.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ReadResult, type ReaderChain, ReaderError, stubReader } from '@yegna/ai';
import { type EnrolResponse, type SyncOp, sheetIdFor, uuidv7 } from '@yegna/shared';
import { addDays, localDateOf, localToUtc, toEthiopian, parseIsoDate, weekdayOf } from '@yegna/time';
import { processImport } from '../src/imports/process.ts';
import { getDb } from '../src/lib/db.ts';
import { type Call, caller, createTestEnv, resetDb, settle, setupDoctor } from './helpers.ts';

let env: Env;
let dispose: () => Promise<void>;
let call: Call;
let doctor: EnrolResponse;

beforeAll(async () => {
  ({ env, dispose } = await createTestEnv({ TEAM_BOT_TOKEN: '123:abc' }));
  call = caller(env);
});
afterAll(() => dispose());
beforeEach(async () => {
  await resetDb(env);
  doctor = await setupDoctor(call);
});

/** Next week's Monday (the clinic is open; nothing else is booked there). */
function nextMonday(): string {
  let d = addDays(localDateOf(Date.now()), 7);
  while (weekdayOf(d) !== 1) d = addDays(d, -1);
  return d;
}

/** Telegram's file API, answering with a tiny JPEG. */
const telegram = (async (url: string) => {
  if (url.includes('/getFile'))
    return Response.json({ ok: true, result: { file_path: 'photos/f.jpg', file_size: 4 } });
  return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
    headers: { 'content-type': 'image/jpeg' },
  });
}) as unknown as typeof fetch;

const chainOf = (result: ReadResult): ReaderChain => ({ primary: [stubReader(result)], lastResort: [] });

async function newImport(): Promise<string> {
  const id = uuidv7();
  await env.DB.prepare(
    "INSERT INTO imports (id, telegram_file_id, uploaded_by, status, created_at, version, updated_at) VALUES (?, 'file-1', ?, 'queued', 0, 0, 0)",
  )
    .bind(id, doctor.user.id)
    .run();
  return id;
}

async function patientWithBooking(phone: string, name: string, startAt: number | null) {
  const patientId = uuidv7();
  const op = (entity: SyncOp['entity'], entityId: string, fields: Record<string, unknown>): SyncOp => ({
    opId: uuidv7(),
    entity,
    entityId,
    kind: 'create',
    fields,
    baseVersion: null,
    at: Date.now(),
    userId: doctor.user.id,
  });
  const ops = [op('patients', patientId, { name, phoneE164: phone })];
  if (startAt) ops.push(op('bookings', uuidv7(), { patientId, procedureId: null, startAt, durationMin: 30 }));
  const res = await call('POST', '/sync', {
    token: doctor.token,
    body: { deviceId: doctor.deviceId, cursor: 0, ops },
  });
  expect(res.status).toBe(200);
  return patientId;
}

async function rowsOf(importId: string) {
  const { results } = await env.DB.prepare(
    'SELECT name_text, match, decision, needs_check, patient_id, duplicate_of_id, start_at, confidence FROM import_rows WHERE import_id = ? ORDER BY name_text',
  )
    .bind(importId)
    .all<Record<string, unknown>>();
  return results;
}

describe('reading an import (PRD §12)', () => {
  it('matches by phone, skips duplicates, flags new and unreadable rows', async () => {
    const monday = nextMonday();
    const at = (h: number, m = 0) => localToUtc(monday, h * 60 + m);
    const abebe = await patientWithBooking('+251911223344', 'Abebe Kebede', at(10, 15)); // 4:15 ET booked
    const hana = await patientWithBooking('+251922334455', 'Hana Tesfaye', null);
    const id = await newImport();

    const out = await processImport(env, getDb(env.DB), id, {
      fetch: telegram,
      chain: chainOf({
        sheetId: sheetIdFor({ template: 'F', monday }),
        rows: [
          { day: 'mon', time: '4:00', name: 'Abebe K.', phone: '0911 22 33 44', confidence: 0.9 }, // dup of 4:15
          { day: 'mon', time: '5:10', name: 'Hana T.', phone: '0922334455', confidence: 0.9 }, // snapped
          { day: 'tue', time: '3:00', name: 'Selam New', phone: '0933445566', confidence: 0.4 },
          { day: 'tue', name: 'No Time', confidence: 0.9 },
        ],
      }),
    });
    expect(out).toEqual({ status: 'read', rows: 4, unreadable: 1 });

    const rows = await rowsOf(id);
    const by = (n: string) => rows.find((r) => r.name_text === n)!;
    expect(by('Abebe K.')).toMatchObject({ match: 'duplicate', decision: 'skip', patient_id: abebe });
    expect(by('Abebe K.').duplicate_of_id).toBeTruthy();
    expect(by('Hana T.')).toMatchObject({
      match: 'existing',
      decision: 'accept',
      patient_id: hana,
      needs_check: 1,
    });
    expect(by('Hana T.').start_at).toBe(at(11, 15));
    expect(by('Selam New')).toMatchObject({
      match: 'new',
      decision: 'accept',
      needs_check: 1,
      confidence: 40,
    });
    expect(by('No Time')).toMatchObject({ match: 'unreadable', decision: null });

    const imp = await env.DB.prepare(
      'SELECT status, provider, template, period_label, raw_result FROM imports WHERE id = ?',
    )
      .bind(id)
      .first<Record<string, string>>();
    expect(imp).toMatchObject({ status: 'read', provider: 'stub', template: 'F' });
    expect(JSON.parse(imp!.raw_result!).promptVersion).toBe('v1');
  });

  it('matches template O rows by name, but never between two equally close patients', async () => {
    const monday = nextMonday();
    const et = toEthiopian(parseIsoDate(monday));
    await patientWithBooking('+251911000001', 'Meseret Alemu', null);
    await patientWithBooking('+251911000002', 'Dawit Bekele', null);
    await patientWithBooking('+251911000003', 'Dawit Bekela', null);
    const id = await newImport();
    await processImport(env, getDb(env.DB), id, {
      fetch: telegram,
      chain: chainOf({
        sheetId: sheetIdFor({ template: 'O', etYear: et.year, etMonth: et.month }),
        rows: [
          { day: String(et.day), time: '4:00', name: 'Meseret Alemu', confidence: 1 },
          { day: String(et.day), time: '5:00', name: 'Dawit Bekeli', confidence: 1 },
        ],
      }),
    });
    const rows = await rowsOf(id);
    expect(rows.find((r) => r.name_text === 'Meseret Alemu')).toMatchObject({
      match: 'existing',
      needs_check: 1,
    });
    expect(rows.find((r) => r.name_text === 'Dawit Bekeli')).toMatchObject({
      match: 'new',
      patient_id: null,
    });
  });

  it('marks rows unreadable when the sheet ID cannot be read (no dates)', async () => {
    const id = await newImport();
    const out = await processImport(env, getDb(env.DB), id, {
      fetch: telegram,
      chain: chainOf({ rows: [{ day: 'mon', time: '4:00', name: 'Abebe', confidence: 1 }] }),
    });
    expect(out).toEqual({ status: 'read', rows: 1, unreadable: 1 });
  });

  it('fails (manual entry) when every reader fails, recording only reader ids and error kinds', async () => {
    const id = await newImport();
    const failing = {
      id: 'workers-ai',
      read: async () => {
        throw new ReaderError('rate_limited');
      },
    };
    const out = await processImport(env, getDb(env.DB), id, {
      fetch: telegram,
      chain: { primary: [failing], lastResort: [] },
    });
    expect(out).toEqual({ status: 'failed' });
    const imp = await env.DB.prepare('SELECT status, raw_result FROM imports WHERE id = ?')
      .bind(id)
      .first<Record<string, string>>();
    expect(imp!.status).toBe('failed');
    expect(JSON.parse(imp!.raw_result!).attempts).toEqual([
      { readerId: 'workers-ai', outcome: 'rate_limited' },
    ]);
    expect(await rowsOf(id)).toEqual([]);
  });

  it('stays queued (to be read later) when the run’s time is up, instead of failing', async () => {
    const id = await newImport();
    const deadline = new AbortController();
    const slow = {
      id: 'slow',
      read: (_input: unknown, signal?: AbortSignal) =>
        new Promise<ReadResult>((_, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    };
    const run = processImport(env, getDb(env.DB), id, {
      fetch: telegram,
      signal: deadline.signal,
      chain: { primary: [slow], lastResort: [] },
    });
    setTimeout(() => deadline.abort(), 30);
    expect(await run).toEqual({ status: 'queued' });
    // Released at once: the Imports screen can read it now.
    expect(
      (
        await processImport(env, getDb(env.DB), id, {
          fetch: telegram,
          chain: chainOf({ rows: [{ name: 'A', confidence: 1 }] }),
        })
      ).status,
    ).toBe('read');
  });

  it('fails when the photo can no longer be fetched from Telegram', async () => {
    const id = await newImport();
    const gone = (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch;
    const reader = stubReader({ rows: [{ name: 'X', confidence: 1 }] });
    expect(
      await processImport(env, getDb(env.DB), id, {
        fetch: gone,
        chain: { primary: [reader], lastResort: [] },
      }),
    ).toEqual({
      status: 'failed',
    });
  });

  it('reads an import once: a second run while it is being read, or after, does nothing', async () => {
    const id = await newImport();
    let release!: () => void;
    const slow = {
      id: 'slow',
      read: () =>
        new Promise<ReadResult>((resolve) => {
          release = () => resolve({ rows: [{ name: 'A', confidence: 1 }] });
        }),
    };
    const first = processImport(env, getDb(env.DB), id, {
      fetch: telegram,
      chain: { primary: [slow], lastResort: [] },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(
      await processImport(env, getDb(env.DB), id, { fetch: telegram, chain: chainOf({ rows: [] }) }),
    ).toEqual({
      status: 'busy',
    });
    release();
    expect((await first).status).toBe('read');
    expect(await processImport(env, getDb(env.DB), id, { fetch: telegram })).toEqual({ status: 'done' });
    expect(await processImport(env, getDb(env.DB), uuidv7(), { fetch: telegram })).toEqual({
      status: 'not_found',
    });
  });
});

/** A fake Telegram for the routes (sendPhoto, getFile, file download, sendMessage). */
function fakeTelegram() {
  const calls: { method: string; body: unknown }[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split('/').at(-1)!.split('?')[0]!;
    calls.push({ method, body: init?.body });
    if (url.includes('/sendPhoto')) {
      return Response.json({
        ok: true,
        result: { message_id: 1, photo: [{ file_id: 'small' }, { file_id: 'big' }] },
      });
    }
    if (url.includes('/getFile'))
      return Response.json({ ok: true, result: { file_path: 'photos/f.jpg', file_size: 4 } });
    if (url.includes('/file/bot'))
      return new Response(new Uint8Array([0xff, 0xd8]), { headers: { 'content-type': 'image/jpeg' } });
    return Response.json({ ok: true, result: { message_id: 2, date: 0, chat: { id: 1, type: 'private' } } });
  };
  return { calls, impl };
}

describe('import routes (PRD §8 item 10)', () => {
  const realFetch = globalThis.fetch;
  let tg: ReturnType<typeof fakeTelegram>;
  beforeEach(() => {
    tg = fakeTelegram();
    globalThis.fetch = tg.impl as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const stubEnv = () => ({ ...env, IMPORT_STUB_READER: '1' });

  it('needs a signed-in device', async () => {
    expect((await call('GET', '/imports')).status).toBe(401);
    expect((await call('GET', `/imports/${uuidv7()}`, { token: doctor.token })).status).toBe(404);
    // Patient lists are never kept in a browser or proxy cache (privacy review M4).
    const list = await call('GET', '/imports', { token: doctor.token });
    expect(list.headers.get('Cache-Control')).toBe('no-store');
  });

  it('uploads a photo from the app: posted to the uploader’s own chat, read in the background', async () => {
    const upload = (token: string) =>
      caller(stubEnv())('POST', '/imports', {
        token,
        raw: { data: new Uint8Array([0xff, 0xd8, 0xff]), type: 'image/jpeg' },
      });
    // Telegram not linked: refused (the photo is kept by Telegram only).
    expect((await upload(doctor.token)).json.error).toBe('telegram_not_linked');
    await env.DB.prepare('UPDATE users SET telegram_chat_id = ? WHERE id = ?')
      .bind('1001', doctor.user.id)
      .run();
    // Not an image.
    const text = await caller(stubEnv())('POST', '/imports', {
      token: doctor.token,
      raw: { data: new Uint8Array([1]), type: 'text/plain' },
    });
    expect(text.status).toBe(400);

    // The size must be declared (411), stay under 5 MB (413), and the bytes must be a photo.
    const sized = (length: string) =>
      caller(stubEnv())('POST', '/imports', {
        token: doctor.token,
        headers: { 'Content-Length': length },
        raw: { data: new Uint8Array([0xff, 0xd8, 0xff]), type: 'image/jpeg' },
      });
    expect((await sized('0')).status).toBe(411);
    expect((await sized(String(6 * 1024 * 1024))).status).toBe(413);
    const fake = await caller(stubEnv())('POST', '/imports', {
      token: doctor.token,
      raw: { data: new Uint8Array([0x3c, 0x68, 0x74, 0x6d]), type: 'image/jpeg' },
    });
    expect(fake.status).toBe(400);

    const res = await upload(doctor.token);
    expect(res.status).toBe(201);
    await settle();
    const id = res.json.id as string;
    const imp = await env.DB.prepare('SELECT telegram_file_id, status, provider FROM imports WHERE id = ?')
      .bind(id)
      .first<Record<string, string>>();
    expect(imp).toEqual({ telegram_file_id: 'big', status: 'read', provider: 'stub' });

    const list = await call('GET', '/imports', { token: doctor.token });
    expect(list.json).toEqual([
      expect.objectContaining({ id, status: 'read', rows: 1, uploadedBy: 'Dr. Selam' }),
    ]);
    const detail = await call('GET', `/imports/${id}`, { token: doctor.token });
    expect((detail.json.rows as unknown[]).length).toBe(1);
    expect(detail.json.rows).toEqual([expect.objectContaining({ nameText: 'Stub Patient', match: 'new' })]);
  });

  it('streams the photo from Telegram, never cached', async () => {
    const id = await newImport();
    const res = await call('GET', `/imports/${id}/photo`, { token: doctor.token });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('reads a queued import on request (the Imports screen)', async () => {
    const id = await newImport();
    const res = await caller(stubEnv())('POST', `/imports/${id}/process`, { token: doctor.token });
    expect(res.json).toEqual({ status: 'read', rows: 1, unreadable: 0 });
    expect((await caller(stubEnv())('POST', `/imports/${id}/process`, { token: doctor.token })).json).toEqual(
      {
        status: 'done',
      },
    );
  });

  it('records the review and reports skipped duplicates to the Doctor', async () => {
    await env.DB.prepare(
      "UPDATE users SET telegram_chat_id = ?, locale = 'en', calendar = 'gregorian' WHERE id = ?",
    )
      .bind('1001', doctor.user.id)
      .run();
    const monday = nextMonday();
    await patientWithBooking('+251911223344', 'Abebe Kebede', localToUtc(monday, 10 * 60));
    const id = await newImport();
    expect(
      (await call('POST', `/imports/${id}/confirm`, { token: doctor.token, body: { rows: [] } })).status,
    ).toBe(409);
    // Refused by the guarded batch itself: nothing of it was written.
    const noAudit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'imports' AND entity_id = ? AND action = 'review'",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(noAudit!.n).toBe(0);
    await processImport(env, getDb(env.DB), id, {
      fetch: telegram,
      chain: chainOf({
        sheetId: sheetIdFor({ template: 'F', monday }),
        rows: [
          { day: 'mon', time: '4:00', name: 'Abebe K.', phone: '0911223344', confidence: 1 },
          { day: 'mon', time: '5:00', name: 'New One', phone: '0944556677', confidence: 1 },
        ],
      }),
    });
    const rows = (await call('GET', `/imports/${id}`, { token: doctor.token })).json.rows as {
      id: string;
      match: string;
    }[];
    const dup = rows.find((r) => r.match === 'duplicate')!;
    const fresh = rows.find((r) => r.match === 'new')!;
    expect(
      (
        await call('POST', `/imports/${id}/confirm`, {
          token: doctor.token,
          body: { rows: [{ id: uuidv7(), decision: 'skip' }] },
        })
      ).status,
    ).toBe(400);

    const res = await call('POST', `/imports/${id}/confirm`, {
      token: doctor.token,
      body: {
        rows: [
          { id: dup.id, decision: 'skip' },
          { id: fresh.id, decision: 'accept' },
        ],
      },
    });
    expect(res.json).toEqual({ status: 'reviewed' });
    await settle();
    const after = await rowsOf(id);
    expect(after.map((r) => r.decision).sort()).toEqual(['accept', 'skip']);
    const imp = await env.DB.prepare('SELECT status FROM imports WHERE id = ?')
      .bind(id)
      .first<{ status: string }>();
    expect(imp!.status).toBe('reviewed');
    // The Doctor was told about the skipped row, with the time already booked.
    const sent = tg.calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.body));
    expect(sent).toEqual([
      expect.stringMatching(/Skipped from the sheet.*Abebe K\..*already booked at 10:00 by Dr\. Selam/),
    ]);
  });

  it('lets only one of two phones confirming at once review the sheet; lists rows still to book', async () => {
    const monday = nextMonday();
    const id = await newImport();
    await processImport(env, getDb(env.DB), id, {
      fetch: telegram,
      chain: chainOf({
        sheetId: sheetIdFor({ template: 'F', monday }),
        rows: [
          { day: 'mon', time: '4:00', name: 'Hana T.', phone: '0922334455', confidence: 1 },
          { day: 'mon', time: '5:00', name: 'Yonas B.', phone: '0933445566', confidence: 1 },
        ],
      }),
    });
    const rows = (await call('GET', `/imports/${id}`, { token: doctor.token })).json.rows as { id: string }[];
    const confirm = (decision: 'accept' | 'skip') =>
      call('POST', `/imports/${id}/confirm`, {
        token: doctor.token,
        body: { rows: rows.map((r) => ({ id: r.id, decision })) },
      });
    const results = await Promise.all([confirm('accept'), confirm('skip')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results[0]!.status === 200 ? 'accept' : 'skip';
    expect((await rowsOf(id)).map((r) => r.decision)).toEqual([winner, winner]);
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'imports' AND entity_id = ? AND action = 'review'",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(audits!.n).toBe(1);

    const listed = (await call('GET', '/imports', { token: doctor.token })).json as unknown as {
      id: string;
      toBook: number;
    }[];
    expect(listed.find((i) => i.id === id)!.toBook).toBe(winner === 'accept' ? 2 : 0);
  });
});
