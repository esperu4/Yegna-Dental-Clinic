/**
 * The Yegna Team bot (PRD §13): linking, refusals, commands and approving, with the Bot API
 * answered in-process (no network).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Transformer } from 'grammy';
import { type EnrolResponse, type SyncOp, uuidv7 } from '@yegna/shared';
import { addDays, localDateOf, localToUtc, weekdayOf } from '@yegna/time';
import { runHourly } from '../src/jobs/dispatch.ts';
import { getDb } from '../src/lib/db.ts';
import { meterD1 } from '../src/lib/queryMeter.ts';
import type { Notifier, OutgoingMessage } from '../src/notify/notifier.ts';
import { BOT_DEVICE_ID, LINK_CODE_TTL_MS, teamBot } from '../src/routes/telegram.ts';
import { type Call, addStaff, caller, createTestEnv, resetDb, setupDoctor } from './helpers.ts';

const BOT = {
  TEAM_BOT_TOKEN: '123456:TEST',
  TEAM_BOT_USERNAME: 'YegnaTeamTestBot',
  TEAM_BOT_WEBHOOK_SECRET: 'whsecret-0123456789',
};
const DOCTOR_CHAT = 5551;
const STAFF_CHAT = 5552;

let env: Env;
let dispose: () => Promise<void>;
let call: Call;
let doctor: EnrolResponse;
let staff: EnrolResponse;

beforeAll(async () => {
  ({ env, dispose } = await createTestEnv(BOT));
  call = caller(env);
});
afterAll(() => dispose());
beforeEach(async () => {
  await resetDb(env);
  doctor = await setupDoctor(call);
  await addStaff(call, doctor.token, 'Hana', '4731');
  staff = (await call('POST', '/enrol', { body: { name: 'Hana', pin: '4731', deviceLabel: 'Front desk' } }))
    .json as unknown as EnrolResponse;
  await env.DB.prepare("UPDATE users SET locale = 'en', calendar = 'gregorian'").run();
});

/** Sends one update to the bot; returns the Bot API calls it made (replies, callback answers). */
async function botReceives(update: object, now = Date.now()) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const answer: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return {
      ok: true,
      result: (method === 'sendMessage'
        ? { message_id: 1, date: 0, chat: { id: 1, type: 'private' } }
        : true) as never,
    };
  };
  const meter = meterD1(env.DB);
  await teamBot(env, getDb(meter.d1), meter, { apiTransformer: answer, now }).handleUpdate(update as never);
  return calls;
}

let updateId = 1;
const person = (id: number) => ({ id, is_bot: false, first_name: 'T' });
const privateChat = (id: number) => ({ id, type: 'private' as const, first_name: 'T' });

function text(chatId: number, body: string, chat: object = privateChat(chatId)) {
  const command = body.startsWith('/') ? body.split(' ')[0]!.length : 0;
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: 0,
      chat,
      from: person(chatId),
      text: body,
      ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command }] } : {}),
    },
  };
}

function tap(chatId: number, data: string, fromId = chatId) {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      from: person(fromId),
      chat_instance: 'x',
      data,
      message: { message_id: 9, date: 0, chat: privateChat(chatId), text: 'digest' },
    },
  };
}

const replies = (calls: Awaited<ReturnType<typeof botReceives>>) =>
  calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
const answers = (calls: Awaited<ReturnType<typeof botReceives>>) =>
  calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload.text as string);

async function linkCode(as: EnrolResponse): Promise<string> {
  const res = await call('POST', '/me/telegram/link', { token: as.token });
  expect(res.status).toBe(200);
  const url = res.json.url as string;
  expect(url).toMatch(/^https:\/\/t\.me\/YegnaTeamTestBot\?start=[0-9a-f]{32}$/);
  return url.split('start=')[1]!;
}

async function link(as: EnrolResponse, chatId: number) {
  await botReceives(text(chatId, `/start ${await linkCode(as)}`));
}

function monday(): string {
  let date = addDays(localDateOf(Date.now()), 2);
  while (weekdayOf(date) !== 1) date = addDays(date, 1);
  return date;
}

let phoneSeq = 0;
async function staffBooking(hh: number): Promise<{ id: string; version: number }> {
  const patientId = uuidv7();
  const bookingId = uuidv7();
  const op = (
    entity: SyncOp['entity'],
    entityId: string,
    fields: Record<string, unknown>,
    kind: SyncOp['kind'] = 'create',
  ): SyncOp => ({
    opId: uuidv7(),
    entity,
    entityId,
    kind,
    fields,
    baseVersion: null,
    at: Date.now(),
    userId: staff.user.id,
  });
  await call('POST', '/sync', {
    token: staff.token,
    body: {
      deviceId: staff.deviceId,
      cursor: 0,
      ops: [
        op('patients', patientId, {
          name: 'Abebe Kebede',
          phoneE164: `+251911${String(++phoneSeq).padStart(6, '0')}`,
        }),
        op('bookings', bookingId, {
          patientId,
          procedureId: null,
          startAt: localToUtc(monday(), hh * 60),
          durationMin: 30,
        }),
      ],
    },
  });
  return bookingRow(bookingId);
}

async function bookingRow(id: string) {
  return (await env.DB.prepare('SELECT id, version, status FROM bookings WHERE id = ?').bind(id).first()) as {
    id: string;
    version: number;
    status: string;
  };
}

describe('team bot: linking (PRD §13)', () => {
  it('links the chat that opens the one-time code, once', async () => {
    const code = await linkCode(doctor);
    const calls = await botReceives(text(DOCTOR_CHAT, `/start ${code}`));
    expect(replies(calls)[0]).toContain('Telegram is now linked');
    const row = await env.DB.prepare('SELECT telegram_chat_id FROM users WHERE id = ?')
      .bind(doctor.user.id)
      .first();
    expect(row?.telegram_chat_id).toBe(String(DOCTOR_CHAT));
    expect((await call('GET', '/me/telegram', { token: doctor.token })).json).toEqual({
      linked: true,
      available: true,
    });
    // Used up.
    expect(replies(await botReceives(text(9999, `/start ${code}`)))[0]).toContain(
      'expired or was already used',
    );
  });

  it('refuses an expired code', async () => {
    const code = await linkCode(doctor);
    const calls = await botReceives(text(DOCTOR_CHAT, `/start ${code}`), Date.now() + LINK_CODE_TTL_MS + 1);
    expect(replies(calls)[0]).toContain('expired');
  });

  it('never links a group chat', async () => {
    const code = await linkCode(doctor);
    const calls = await botReceives(text(-100, `/start ${code}`, { id: -100, type: 'group', title: 'g' }));
    expect(calls).toEqual([]);
    const row = await env.DB.prepare('SELECT telegram_chat_id FROM users WHERE id = ?')
      .bind(doctor.user.id)
      .first();
    expect(row?.telegram_chat_id).toBeNull();
  });

  it('unlinks from the app', async () => {
    await link(doctor, DOCTOR_CHAT);
    await call('DELETE', '/me/telegram', { token: doctor.token });
    expect(replies(await botReceives(text(DOCTOR_CHAT, '/today')))[0]).toContain('only for the Yegna');
  });

  it('says linking is not available while the bot is not set up', async () => {
    const plain = caller({ ...env, TEAM_BOT_TOKEN: '' } as Env);
    const res = await plain('POST', '/me/telegram/link', { token: doctor.token });
    expect(res.status).toBe(503);
    expect(res.json.error).toBe('not_configured');
  });
});

describe('team bot: who it serves', () => {
  it('politely refuses anyone not linked, and nothing more', async () => {
    const calls = await botReceives(text(7777, 'hello'));
    expect(replies(calls)).toEqual([expect.stringContaining('only for the Yegna Dental Clinic team')]);
  });

  it('checks the webhook secret first', async () => {
    const bad = await call('POST', '/telegram/team', {
      body: {},
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'nope' },
    });
    expect(bad.status).toBe(401);
    const ok = await call('POST', '/telegram/team', {
      body: {
        update_id: 1,
        edited_channel_post: { message_id: 1, date: 0, chat: { id: -1, type: 'channel', title: 'c' } },
      },
      headers: { 'X-Telegram-Bot-Api-Secret-Token': BOT.TEAM_BOT_WEBHOOK_SECRET },
    });
    expect(ok.status).toBe(200);
  });

  it('answers /tomorrow with the schedule', async () => {
    await link(staff, STAFF_CHAT);
    await staffBooking(10);
    const sunday = localToUtc(addDays(monday(), -1), 12 * 60);
    const calls = await botReceives(text(STAFF_CHAT, '/tomorrow'), sunday);
    expect(replies(calls)[0]).toMatch(/^Tomorrow \(.+\): 1\n• 10:00 · Abebe Kebede$/);
  });
});

describe('team bot: approving (PRD §13, §10)', () => {
  it('approves a booking from its button, through the sync rules, once', async () => {
    await link(doctor, DOCTOR_CHAT);
    const b = await staffBooking(10);
    const first = await botReceives(tap(DOCTOR_CHAT, `approve:${b.id}:${b.version}`));
    expect(answers(first)).toEqual(['✓ 1 approved']);
    expect((await bookingRow(b.id)).status).toBe('approved');
    const audit = await env.DB.prepare(
      "SELECT device_id FROM audit_log WHERE entity_id = ? AND action = 'status:approved'",
    )
      .bind(b.id)
      .first();
    expect(audit?.device_id).toBe(BOT_DEVICE_ID);
    // A double tap changes nothing.
    expect(answers(await botReceives(tap(DOCTOR_CHAT, `approve:${b.id}:${b.version}`)))).toEqual([
      '✓ 1 approved',
    ]);
  });

  it('does not approve a booking changed since it was shown', async () => {
    await link(doctor, DOCTOR_CHAT);
    const b = await staffBooking(10);
    await env.DB.prepare('UPDATE bookings SET version = version + 1000 WHERE id = ?').bind(b.id).run();
    const calls = await botReceives(tap(DOCTOR_CHAT, `approve:${b.id}:${b.version}`));
    expect(answers(calls)[0]).toContain('changed since');
    expect((await bookingRow(b.id)).status).toBe('pending_approval');
  });

  it('refuses Staff, strangers and a forwarded button with the same generic answer', async () => {
    await link(doctor, DOCTOR_CHAT);
    await link(staff, STAFF_CHAT);
    const b = await staffBooking(10);
    for (const update of [
      tap(STAFF_CHAT, `approve:${b.id}:${b.version}`),
      tap(7777, `approve:${b.id}:${b.version}`),
      tap(DOCTOR_CHAT, `approve:${b.id}:${b.version}`, 7777),
    ]) {
      expect(answers(await botReceives(update))).toEqual([expect.stringContaining('can’t be done')]);
    }
    expect((await bookingRow(b.id)).status).toBe('pending_approval');
  });

  it('"Approve listed" approves only what that digest listed', async () => {
    await link(doctor, DOCTOR_CHAT);
    const listed = await staffBooking(10);
    const sent: OutgoingMessage[] = [];
    const telegram: Notifier = { send: async (_chat, m) => void sent.push(m) };
    await runHourly(env, localToUtc(addDays(monday(), -3), 9 * 60), telegram);
    const data = sent[0]!.buttons![0]![0]! as { data: string };
    expect(data.data).toMatch(/^all:/);
    // A booking made after the digest was sent is not in it.
    const later = await staffBooking(15);
    expect(answers(await botReceives(tap(DOCTOR_CHAT, data.data)))).toEqual(['✓ 1 approved']);
    expect((await bookingRow(listed.id)).status).toBe('approved');
    expect((await bookingRow(later.id)).status).toBe('pending_approval');
  });
});

describe('team bot: connecting the webhook', () => {
  it('is for the Doctor only', async () => {
    const res = await call('POST', '/admin/telegram/connect', { token: staff.token });
    expect(res.status).toBe(403);
  });
});
