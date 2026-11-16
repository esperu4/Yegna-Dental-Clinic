/**
 * The Yegna Dental patient bot (PRD §14, §20 M5): menu, contact linking with the `user_id` check,
 * confirmations, reminders, request buttons → call list and team alert. Above all: **nothing is
 * ever sent for a booking that is not approved.** Telegram is answered in-process.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Transformer } from 'grammy';
import { type EnrolResponse, type SyncOp, uuidv7 } from '@yegna/shared';
import { addDays, localDateOf, localToUtc, weekdayOf } from '@yegna/time';
import { runHourly } from '../src/jobs/dispatch.ts';
import { getDb } from '../src/lib/db.ts';
import type { Notifier, OutgoingMessage } from '../src/notify/notifier.ts';
import { patientBot } from '../src/routes/patientBot.ts';
import { type Call, addStaff, caller, createTestEnv, resetDb, settle, setupDoctor } from './helpers.ts';

const BOT = { PATIENT_BOT_TOKEN: '654321:PATIENT', PATIENT_BOT_WEBHOOK_SECRET: 'patient-secret-0123456789' };
const PATIENT_CHAT = 7001;
const STRANGER_CHAT = 7002;
const PHONE = '+251911223344';
const TEAM_CHAT = '1001';

let env: Env;
let dispose: () => Promise<void>;
let call: Call;
let doctor: EnrolResponse;
let staff: EnrolResponse;

class FakeTelegram implements Notifier {
  sent: { chatId: string; message: OutgoingMessage }[] = [];
  async send(chatId: string, message: OutgoingMessage) {
    this.sent.push({ chatId, message });
  }
  to(chatId: string | number, startsWith = '') {
    return this.sent.filter((s) => s.chatId === String(chatId) && s.message.text.startsWith(startsWith));
  }
}

// The sync route sends patient messages through Telegram's HTTP API: answer it in-process.
const realFetch = globalThis.fetch;
let httpSent: { method: string; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  ({ env, dispose } = await createTestEnv(BOT));
  call = caller(env);
});
afterAll(() => dispose());
beforeEach(async () => {
  httpSent = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.telegram.org/')) return realFetch(input, init);
    httpSent.push({ method: url.split('/').at(-1)!, body: JSON.parse(String(init?.body ?? '{}')) });
    return Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } });
  }) as typeof fetch;
  await resetDb(env);
  doctor = await setupDoctor(call);
  await addStaff(call, doctor.token, 'Hana', '4731');
  staff = (await call('POST', '/enrol', { body: { name: 'Hana', pin: '4731', deviceLabel: 'Front desk' } }))
    .json as unknown as EnrolResponse;
  await env.DB.prepare("UPDATE users SET telegram_chat_id = ?, locale = 'en' WHERE id = ?")
    .bind(TEAM_CHAT, doctor.user.id)
    .run();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------------------------
// Helpers

function monday(): string {
  let date = addDays(localDateOf(Date.now()), 2);
  while (weekdayOf(date) !== 1) date = addDays(date, 1);
  return date;
}
const at = (date: string, hh: number, mm = 0) => localToUtc(date, hh * 60 + mm);

function op(
  as: EnrolResponse,
  entity: SyncOp['entity'],
  entityId: string,
  kind: SyncOp['kind'],
  fields: Record<string, unknown>,
  baseVersion: number | null = null,
): SyncOp {
  return { opId: uuidv7(), entity, entityId, kind, fields, baseVersion, at: Date.now(), userId: as.user.id };
}

async function sync(as: EnrolResponse, ops: SyncOp[]) {
  const res = await call('POST', '/sync', {
    token: as.token,
    body: { deviceId: as.deviceId, cursor: 0, ops },
  });
  expect(res.status).toBe(200);
  await settle();
  return res.json.results as { outcome: string }[];
}

let patientId: string;
/** The patient (phone `PHONE`), created by Staff with no booking yet. */
async function createPatient() {
  patientId = uuidv7();
  await sync(staff, [op(staff, 'patients', patientId, 'create', { name: 'Abebe Kebede', phoneE164: PHONE })]);
}

/** A booking on Monday at `hh`:00 by `as` (Staff ⇒ pending approval; Doctor ⇒ approved). */
async function book(as: EnrolResponse, hh: number): Promise<string> {
  const id = uuidv7();
  const [result] = await sync(as, [
    op(as, 'bookings', id, 'create', {
      patientId,
      procedureId: null,
      startAt: at(monday(), hh),
      durationMin: 30,
    }),
  ]);
  expect(result!.outcome).toBe('applied');
  return id;
}

async function versionOf(id: string) {
  return (await env.DB.prepare('SELECT version FROM bookings WHERE id = ?')
    .bind(id)
    .first<{ version: number }>())!.version;
}
async function setStatus(as: EnrolResponse, id: string, fields: Record<string, unknown>) {
  return sync(as, [op(as, 'bookings', id, 'update', fields, await versionOf(id))]);
}

/** Runs `work` with no patient bot configured (the sync route then sends nothing). */
async function withoutPatientBot<T>(work: () => Promise<T>): Promise<T> {
  const saved = env.PATIENT_BOT_TOKEN!;
  delete env.PATIENT_BOT_TOKEN;
  try {
    return await work();
  } finally {
    env.PATIENT_BOT_TOKEN = saved;
  }
}

async function linkPatientChat(chatId = PATIENT_CHAT) {
  await env.DB.prepare("UPDATE patients SET telegram_chat_id = ?, telegram_locale = 'en' WHERE id = ?")
    .bind(String(chatId), patientId)
    .run();
}

/** Sends one update to the bot; returns the Bot API calls it made. */
async function botReceives(update: object, options: { now?: number; team?: Notifier } = {}) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const answer: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return {
      ok: true,
      result: (method.startsWith('send')
        ? { message_id: 1, date: 0, chat: { id: 1, type: 'private' } }
        : true) as never,
    };
  };
  await patientBot(env, getDb(env.DB), { apiTransformer: answer, ...options }).handleUpdate(update as never);
  return calls;
}
const texts = (calls: Awaited<ReturnType<typeof botReceives>>) =>
  calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);

let updateId = 1;
const person = (id: number) => ({ id, is_bot: false, first_name: 'P' });
const privateChat = (id: number) => ({ id, type: 'private' as const, first_name: 'P' });
function message(chatId: number, extra: object, fromId = chatId) {
  return {
    update_id: updateId++,
    message: { message_id: updateId, date: 0, chat: privateChat(chatId), from: person(fromId), ...extra },
  };
}
const text = (chatId: number, body: string) =>
  message(chatId, {
    text: body,
    ...(body.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: body.length }] } : {}),
  });
/** A shared contact; `userId: null` = a contact card without a Telegram user (typed by hand). */
const contact = (chatId: number, phone: string, userId: number | null = chatId, language?: string) => {
  const update = message(chatId, {
    contact: { phone_number: phone, first_name: 'P', ...(userId !== null ? { user_id: userId } : {}) },
  });
  if (language) Object.assign(update.message.from, { language_code: language });
  return update;
};
const tap = (chatId: number, data: string) => ({
  update_id: updateId++,
  callback_query: {
    id: `cb${updateId}`,
    from: person(chatId),
    chat_instance: 'x',
    data,
    message: { message_id: 9, date: 0, chat: privateChat(chatId), text: 'reminder' },
  },
});

// ---------------------------------------------------------------------------------------------

describe('patient bot webhook (PRD §14, §18)', () => {
  it('refuses updates without the secret', async () => {
    const res = await call('POST', '/telegram/patient', { body: text(PATIENT_CHAT, '/start') });
    expect(res.status).toBe(401);
    const ok = await call('POST', '/telegram/patient', {
      body: text(PATIENT_CHAT, '/start'),
      headers: { 'X-Telegram-Bot-Api-Secret-Token': BOT.PATIENT_BOT_WEBHOOK_SECRET },
    });
    expect(ok.status).toBe(200);
  });

  it('connecting the bot is for the Doctor only', async () => {
    expect((await call('POST', '/admin/telegram/patient/connect', { token: staff.token })).status).toBe(403);
    expect((await call('POST', '/admin/telegram/patient/connect', { token: doctor.token })).status).toBe(200);
    expect(httpSent.map((c) => c.method)).toEqual(['setWebhook', 'setMyCommands']);
    expect(httpSent[0]!.body).toMatchObject({ secret_token: BOT.PATIENT_BOT_WEBHOOK_SECRET });
  });
});

describe('menu (PRD §14)', () => {
  it('/start asks for the language, then shows the menu in it', async () => {
    const start = await botReceives(text(STRANGER_CHAT, '/start'));
    expect(texts(start)[0]).toMatch(/Choose your language/);
    const english = await botReceives(text(STRANGER_CHAT, 'English'));
    expect(texts(english)[0]).toMatch(/^Welcome to Yegna Dental Clinic/);
    const keyboard = (english[0]!.payload.reply_markup as { keyboard: { text: string }[][] }).keyboard.flat();
    expect(keyboard.map((b) => b.text)).toEqual(
      expect.arrayContaining([
        '📅 My appointment',
        '📍 Location',
        '🕘 Hours',
        '📞 Call the clinic',
        '🦷 Services',
      ]),
    );
  });

  it('answers location, hours, call and services', async () => {
    const location = await botReceives(text(STRANGER_CHAT, '📍 Location'));
    expect(location.map((c) => c.method)).toEqual(['sendLocation', 'sendMessage']);
    const hours = await botReceives(text(STRANGER_CHAT, '🕘 Hours'));
    expect(texts(hours)[0]).toMatch(/Ethiopian time/);
    expect(texts(hours)[0]).toMatch(/Sunday: closed/);
    const ring = await botReceives(text(STRANGER_CHAT, '📞 Call the clinic'));
    expect(ring.map((c) => c.method)).toEqual(['sendContact', 'sendMessage']);
    const services = await botReceives(text(STRANGER_CHAT, '🦷 አገልግሎቶች'));
    expect(texts(services)[0]).toMatch(/^🦷 አገልግሎቶቻችን/);
  });

  it('ignores groups and forwarded messages', async () => {
    const group = await botReceives({
      update_id: updateId++,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: -5, type: 'group', title: 'G' },
        from: person(1),
        text: '/start',
      },
    });
    expect(group).toHaveLength(0);
  });
});

describe('contact linking (PRD §14)', () => {
  beforeEach(createPatient);

  it('"My appointment" asks an unlinked chat to share its contact', async () => {
    const calls = await botReceives(text(STRANGER_CHAT, '📅 My appointment'));
    const keyboard = (calls[0]!.payload.reply_markup as { keyboard: { request_contact?: boolean }[][] })
      .keyboard;
    expect(keyboard[0]![0]!.request_contact).toBe(true);
  });

  // Strangers get Amharic (the clinic's language) unless their Telegram is set to English.
  it('refuses a contact that is not the sender’s own (user_id check)', async () => {
    const other = await botReceives(contact(STRANGER_CHAT, PHONE, 999));
    expect(texts(other)[0]).toBe('እባክዎ የራስዎን ቁጥር በቁልፉ ያጋሩ።');
    const noUser = await botReceives(contact(STRANGER_CHAT, PHONE, null));
    expect(texts(noUser)[0]).toBe('እባክዎ የራስዎን ቁጥር በቁልፉ ያጋሩ።');
    const row = await env.DB.prepare('SELECT telegram_chat_id FROM patients').first<{
      telegram_chat_id: string | null;
    }>();
    expect(row!.telegram_chat_id).toBeNull();
  });

  it('a number nobody booked: "We couldn’t find your booking"', async () => {
    const calls = await botReceives(contact(STRANGER_CHAT, '+251922000000', STRANGER_CHAT, 'en'));
    expect(texts(calls)[0]).toMatch(/couldn.t find your booking/);
  });

  it('links a matching phone (any format), lists only approved bookings, and bumps the version', async () => {
    await book(staff, 10); // pending: not listed
    await book(doctor, 14);
    const before = await env.DB.prepare('SELECT version FROM patients WHERE id = ?')
      .bind(patientId)
      .first<{ version: number }>();
    const calls = await botReceives(contact(PATIENT_CHAT, '251 911 22 33 44', PATIENT_CHAT, 'en'));
    const [linked, list] = texts(calls);
    expect(linked).toMatch(/You are connected/);
    expect(list).toMatch(/Your appointment/);
    expect(list!.split('\n')).toHaveLength(2); // only the approved one
    const row = await env.DB.prepare(
      'SELECT telegram_chat_id, telegram_locale, version FROM patients WHERE id = ?',
    )
      .bind(patientId)
      .first<{ telegram_chat_id: string; telegram_locale: string; version: number }>();
    expect(row).toMatchObject({ telegram_chat_id: String(PATIENT_CHAT), telegram_locale: 'en' });
    expect(row!.version).toBeGreaterThan(before!.version);
  });
});

describe('messages to patients: only for approved bookings (PRD §14, §20 M5)', () => {
  beforeEach(async () => {
    await createPatient();
    await linkPatientChat();
  });

  it('never sends anything for a booking that is not approved', async () => {
    await book(staff, 10); // waits for approval
    const declined = await book(staff, 11);
    await setStatus(doctor, declined, { status: 'cancelled', cancelReason: 'declined' });
    const telegram = new FakeTelegram();
    // Every hour of the day before, including the reminder hour, and twice.
    const sunday = addDays(monday(), -1);
    for (const hh of [9, 12, 18, 19, 23, 18])
      await runHourly(env, at(sunday, hh), new FakeTelegram(), telegram);
    await runHourly(env, Date.now() + 60_000, new FakeTelegram(), telegram);
    expect(telegram.to(PATIENT_CHAT)).toHaveLength(0);
    // Nor through the sync route (which messages patients right after a change).
    expect(httpSent.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
  });

  it('confirms an approval once, right after the sync, and again only for a new time', async () => {
    const id = await book(staff, 10);
    expect(httpSent).toHaveLength(0);
    await setStatus(doctor, id, { status: 'approved' });
    const sent = httpSent.filter((c) => c.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ chat_id: String(PATIENT_CHAT) });
    expect(sent[0]!.body.text).toMatch(/^✅ Your appointment is confirmed/);
    // The hourly catch-up does not send it again.
    const telegram = new FakeTelegram();
    await runHourly(env, Date.now() + 60_000, new FakeTelegram(), telegram);
    expect(telegram.to(PATIENT_CHAT)).toHaveLength(0);
    // Staff move it: back to approval, nothing sent; approved again: a new confirmation.
    httpSent = [];
    await setStatus(staff, id, { startAt: at(monday(), 15) });
    expect(httpSent).toHaveLength(0);
    await setStatus(doctor, id, { status: 'approved' });
    expect(httpSent.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
  });

  it('the hourly run confirms what the sync could not send', async () => {
    // Without the bot at sync time, nothing is sent then.
    await withoutPatientBot(() => book(doctor, 10));
    const telegram = new FakeTelegram();
    await runHourly(env, Date.now() + 60_000, new FakeTelegram(), telegram);
    await runHourly(env, Date.now() + 120_000, new FakeTelegram(), telegram);
    expect(telegram.to(PATIENT_CHAT, '✅')).toHaveLength(1);
  });

  it('reminds the day before from 18:00, once; a cancellation is told only if confirmed', async () => {
    // Without the bot at sync time, nothing is sent then.
    const told = await withoutPatientBot(() => book(doctor, 10));
    const telegram = new FakeTelegram();
    const sunday = addDays(monday(), -1);
    await runHourly(env, at(sunday, 17), new FakeTelegram(), telegram);
    expect(telegram.to(PATIENT_CHAT, '🔔')).toHaveLength(0);
    await runHourly(env, at(sunday, 18), new FakeTelegram(), telegram);
    await runHourly(env, at(sunday, 19), new FakeTelegram(), telegram);
    const reminders = telegram.to(PATIENT_CHAT, '🔔');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.message.buttons!.flat().map((b) => ('data' in b ? b.data : ''))).toEqual([
      `p:c:${told}:${at(monday(), 10)}`,
      `p:r:${told}:${at(monday(), 10)}`,
      `p:x:${told}:${at(monday(), 10)}`,
    ]);

    // Cancelled before any confirmation reached the patient: nothing to tell.
    await setStatus(doctor, told, { status: 'cancelled', cancelReason: 'clinic closed' });
    await runHourly(env, Date.now() + 60_000, new FakeTelegram(), telegram);
    expect(telegram.to(PATIENT_CHAT, '❌')).toHaveLength(0);

    // Confirmed, then cancelled by the clinic: told once.
    const second = await book(doctor, 15);
    expect(
      httpSent.filter((c) => c.method === 'sendMessage' && String(c.body.text).startsWith('✅')),
    ).toHaveLength(1);
    await setStatus(doctor, second, { status: 'cancelled', cancelReason: 'doctor away' });
    const cancelNotices = httpSent.filter((c) => String(c.body.text).startsWith('❌'));
    expect(cancelNotices).toHaveLength(1);
    await runHourly(env, Date.now() + 60_000, new FakeTelegram(), telegram);
    expect(telegram.to(PATIENT_CHAT, '❌')).toHaveLength(0);
  });

  it('nothing reaches a patient whose record was deleted (erased)', async () => {
    // Without the bot at sync time, nothing is sent then.
    await withoutPatientBot(() => book(doctor, 10));
    const version = (await env.DB.prepare('SELECT version FROM patients WHERE id = ?')
      .bind(patientId)
      .first<{ version: number }>())!.version;
    await sync(doctor, [op(doctor, 'patients', patientId, 'delete', {}, version)]);
    const telegram = new FakeTelegram();
    await runHourly(env, Date.now() + 60_000, new FakeTelegram(), telegram);
    await runHourly(env, at(addDays(monday(), -1), 18), new FakeTelegram(), telegram);
    expect(telegram.sent.filter((s) => s.chatId === String(PATIENT_CHAT))).toHaveLength(0);
  });
});

describe('reminder buttons (PRD §14)', () => {
  let bookingId: string;
  /** A reminder button for the booking at its time on Monday 10:00. */
  const button = (action: 'c' | 'r' | 'x', startAt = at(monday(), 10)) =>
    `p:${action}:${bookingId}:${startAt}`;
  beforeEach(async () => {
    await createPatient();
    await linkPatientChat();
    // Without the bot at sync time, nothing is sent then.
    bookingId = await withoutPatientBot(() => book(doctor, 10));
  });

  it('Confirm sets patient_confirmed_at (once) with a new version', async () => {
    const before = await versionOf(bookingId);
    const calls = await botReceives(tap(PATIENT_CHAT, button('c')));
    expect(texts(calls)[0]).toMatch(/Thank you/);
    const row = await env.DB.prepare('SELECT patient_confirmed_at, version FROM bookings WHERE id = ?')
      .bind(bookingId)
      .first<{ patient_confirmed_at: number; version: number }>();
    expect(row!.patient_confirmed_at).toBeGreaterThan(0);
    expect(row!.version).toBeGreaterThan(before);
    await botReceives(tap(PATIENT_CHAT, button('c')));
    expect(await versionOf(bookingId)).toBe(row!.version);
  });

  it('Reschedule and Cancel open one request each and alert the team once', async () => {
    const team = new FakeTelegram();
    for (let i = 0; i < 2; i++) {
      const calls = await botReceives(tap(PATIENT_CHAT, button('r')), { team });
      expect(texts(calls)[0]).toBe('The clinic will call you.');
    }
    await botReceives(tap(PATIENT_CHAT, button('x')), { team });
    const requests = await env.DB.prepare(
      'SELECT kind, status, patient_id FROM patient_requests ORDER BY kind',
    ).all();
    expect(requests.results).toEqual([
      { kind: 'cancel', status: 'open', patient_id: patientId },
      { kind: 'reschedule', status: 'open', patient_id: patientId },
    ]);
    expect(team.to(TEAM_CHAT, '🔁')).toHaveLength(1);
    expect(team.to(TEAM_CHAT, '❌')).toHaveLength(1);
    expect(team.to(TEAM_CHAT, '🔁')[0]!.message.text).toMatch(/Abebe Kebede/);
  });

  it('a button from another chat, or for a booking no longer approved, does nothing', async () => {
    const stranger = await botReceives(tap(STRANGER_CHAT, button('x')));
    expect(texts(stranger)[0]).toMatch(/^ይህ ቀጠሮ ተቀይሯል/);
    await setStatus(staff, bookingId, { startAt: at(monday(), 15) }); // back to approval
    const stale = await botReceives(tap(PATIENT_CHAT, button('c')));
    expect(texts(stale)[0]).toMatch(/has changed/);
    const n = await env.DB.prepare('SELECT count(*) AS n FROM patient_requests').first<{ n: number }>();
    expect(n!.n).toBe(0);
    const row = await env.DB.prepare('SELECT patient_confirmed_at FROM bookings WHERE id = ?')
      .bind(bookingId)
      .first();
    expect(row!.patient_confirmed_at).toBeNull();
  });

  it('an old reminder’s button does nothing after the booking moved, even once approved again', async () => {
    await setStatus(doctor, bookingId, { startAt: at(monday(), 15) }); // the Doctor moves it: still approved
    const old = await botReceives(tap(PATIENT_CHAT, button('c')));
    expect(texts(old)[0]).toMatch(/has changed/);
    const current = await botReceives(tap(PATIENT_CHAT, button('c', at(monday(), 15))));
    expect(texts(current)[0]).toMatch(/Thank you/);
  });

  it('a handled request is not reopened by more taps', async () => {
    const team = new FakeTelegram();
    await botReceives(tap(PATIENT_CHAT, button('r')), { team });
    await env.DB.prepare("UPDATE patient_requests SET status = 'handled'").run();
    await botReceives(tap(PATIENT_CHAT, button('r')), { team });
    const n = await env.DB.prepare('SELECT count(*) AS n FROM patient_requests').first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(team.to(TEAM_CHAT, '🔁')).toHaveLength(1);
  });
});

describe('privacy review M5', () => {
  beforeEach(async () => {
    await createPatient();
    await linkPatientChat();
  });

  it('a time moved after the confirmation, then cancelled, is never told to the patient', async () => {
    const id = await book(doctor, 10); // confirmed at 10:00
    expect(httpSent.filter((c) => String(c.body.text).startsWith('✅'))).toHaveLength(1);
    await setStatus(staff, id, { startAt: at(monday(), 15) }); // back to approval at 15:00
    await setStatus(doctor, id, { status: 'cancelled', cancelReason: 'doctor away' });
    const telegram = new FakeTelegram();
    await runHourly(env, Date.now() + 60_000, new FakeTelegram(), telegram);
    expect(httpSent.filter((c) => String(c.body.text).startsWith('❌'))).toHaveLength(0);
    expect(telegram.to(PATIENT_CHAT)).toHaveLength(0);
  });

  it('a new phone number ends the Telegram link', async () => {
    const version = (await env.DB.prepare('SELECT version FROM patients WHERE id = ?')
      .bind(patientId)
      .first<{ version: number }>())!.version;
    await sync(staff, [op(staff, 'patients', patientId, 'update', { phoneE164: '+251922334455' }, version)]);
    const row = await env.DB.prepare('SELECT telegram_chat_id, telegram_locale FROM patients WHERE id = ?')
      .bind(patientId)
      .first();
    expect(row).toEqual({ telegram_chat_id: null, telegram_locale: null });
    // A name change keeps it.
    await linkPatientChat();
    const v2 = (await env.DB.prepare('SELECT version FROM patients WHERE id = ?')
      .bind(patientId)
      .first<{ version: number }>())!.version;
    await sync(staff, [op(staff, 'patients', patientId, 'update', { name: 'Abebe K.' }, v2)]);
    const kept = await env.DB.prepare('SELECT telegram_chat_id FROM patients WHERE id = ?')
      .bind(patientId)
      .first();
    expect(kept).toEqual({ telegram_chat_id: String(PATIENT_CHAT) });
  });

  it('erasing a patient also erases which chat was told about their bookings', async () => {
    await book(doctor, 10);
    const logged = () =>
      env.DB.prepare("SELECT count(*) AS n FROM notification_log WHERE kind LIKE 'patient_%'").first<{
        n: number;
      }>();
    expect((await logged())!.n).toBe(1);
    const version = (await env.DB.prepare('SELECT version FROM patients WHERE id = ?')
      .bind(patientId)
      .first<{ version: number }>())!.version;
    await sync(doctor, [op(doctor, 'patients', patientId, 'delete', {}, version)]);
    expect((await logged())!.n).toBe(0);
  });
});
