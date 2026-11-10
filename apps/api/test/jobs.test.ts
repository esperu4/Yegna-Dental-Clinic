/**
 * The hourly cron's team jobs (PRD §13, §16), with a fake Telegram. Every job must send each
 * message once, however often it runs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type EnrolResponse, type SyncOp, uuidv7 } from '@yegna/shared';
import { addDays, localDateOf, localToUtc, weekdayOf } from '@yegna/time';
import { runHourly } from '../src/jobs/dispatch.ts';
import type { Notifier, OutgoingMessage } from '../src/notify/notifier.ts';
import { type Call, addStaff, caller, createTestEnv, resetDb, setupDoctor } from './helpers.ts';

let env: Env;
let dispose: () => Promise<void>;
let call: Call;
let doctor: EnrolResponse;
let staff: EnrolResponse;

const DOCTOR_CHAT = '1001';
const STAFF_CHAT = '1002';

/** Records every message; `failNext` makes the next send fail (Telegram down). */
class FakeTelegram implements Notifier {
  sent: { chatId: string; message: OutgoingMessage }[] = [];
  failNext = 0;
  async send(chatId: string, message: OutgoingMessage) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('telegram down');
    }
    this.sent.push({ chatId, message });
  }
  to(chatId: string, startsWith: string) {
    return this.sent.filter((s) => s.chatId === chatId && s.message.text.startsWith(startsWith));
  }
}

beforeAll(async () => {
  ({ env, dispose } = await createTestEnv());
  call = caller(env);
});
afterAll(() => dispose());
beforeEach(async () => {
  await resetDb(env);
  doctor = await setupDoctor(call);
  await addStaff(call, doctor.token, 'Hana', '4731');
  staff = (await call('POST', '/enrol', { body: { name: 'Hana', pin: '4731', deviceLabel: 'Front desk' } }))
    .json as unknown as EnrolResponse;
  // Both linked Telegram, in English and the Gregorian calendar (easier to read in tests).
  await env.DB.prepare(
    "UPDATE users SET telegram_chat_id = ?, locale = 'en', calendar = 'gregorian' WHERE id = ?",
  )
    .bind(DOCTOR_CHAT, doctor.user.id)
    .run();
  await env.DB.prepare(
    "UPDATE users SET telegram_chat_id = ?, locale = 'en', calendar = 'gregorian' WHERE id = ?",
  )
    .bind(STAFF_CHAT, staff.user.id)
    .run();
});

/** The next Monday at least two days away (open 09:00–18:00), as a local date. */
function monday(): string {
  let date = addDays(localDateOf(Date.now()), 2);
  while (weekdayOf(date) !== 1) date = addDays(date, 1);
  return date;
}
const sunday = () => addDays(monday(), -1);
const at = (date: string, hh: number, mm = 0) => localToUtc(date, hh * 60 + mm);

let phoneSeq = 0;
/** Staff book a new patient (no Telegram) on Monday at `hh`:00: it waits for approval. */
async function staffBooking(hh: number, name = 'Abebe Kebede') {
  const patientId = uuidv7();
  const op = (entity: SyncOp['entity'], entityId: string, fields: Record<string, unknown>): SyncOp => ({
    opId: uuidv7(),
    entity,
    entityId,
    kind: 'create',
    fields,
    baseVersion: null,
    at: Date.now(),
    userId: staff.user.id,
  });
  const bookingId = uuidv7();
  const res = await call('POST', '/sync', {
    token: staff.token,
    body: {
      deviceId: staff.deviceId,
      cursor: 0,
      ops: [
        op('patients', patientId, { name, phoneE164: `+251911${String(++phoneSeq).padStart(6, '0')}` }),
        op('bookings', bookingId, {
          patientId,
          procedureId: null,
          startAt: at(monday(), hh),
          durationMin: 30,
        }),
      ],
    },
  });
  expect(res.status).toBe(200);
  return bookingId;
}

describe('hourly cron: team jobs (PRD §13, §16)', () => {
  it('alerts the team once about a booking unapproved within 24 h', async () => {
    await staffBooking(10);
    const telegram = new FakeTelegram();
    // Sunday 11:00: the 10:00 Monday booking is 23 h away.
    await runHourly(env, at(sunday(), 11), telegram);
    await runHourly(env, at(sunday(), 11, 5), telegram);
    await runHourly(env, at(sunday(), 12), telegram);
    expect(telegram.to(DOCTOR_CHAT, '⏳')).toHaveLength(1);
    expect(telegram.to(STAFF_CHAT, '⏳')).toHaveLength(1);
    // The Doctor can approve from the alert; Staff can't.
    expect(telegram.to(DOCTOR_CHAT, '⏳')[0]!.message.buttons?.[0]?.[0]).toMatchObject({
      data: expect.stringMatching(/^approve:/),
    });
    expect(telegram.to(STAFF_CHAT, '⏳')[0]!.message.buttons).toBeUndefined();
  });

  it('does not alert before 24 h', async () => {
    await staffBooking(10);
    const telegram = new FakeTelegram();
    await runHourly(env, at(sunday(), 9), telegram);
    expect(telegram.to(DOCTOR_CHAT, '⏳')).toHaveLength(0);
  });

  it('sends the Doctor an approval digest only when new bookings are waiting', async () => {
    await staffBooking(10);
    const telegram = new FakeTelegram();
    const morning = addDays(sunday(), -2);
    await runHourly(env, at(morning, 8), telegram);
    await runHourly(env, at(morning, 8, 30), telegram);
    await runHourly(env, at(morning, 9), telegram);
    expect(telegram.to(DOCTOR_CHAT, '1 bookings waiting')).toHaveLength(1);
    expect(telegram.to(STAFF_CHAT, '1 bookings waiting')).toHaveLength(0);
    // A new booking: the next hour's digest lists both.
    await staffBooking(15, 'Tigist Alemu');
    await runHourly(env, at(morning, 10), telegram);
    const digests = telegram.to(DOCTOR_CHAT, '2 bookings waiting');
    expect(digests).toHaveLength(1);
    expect(digests[0]!.message.buttons?.[0]?.[0]).toMatchObject({
      data: expect.stringMatching(/^all:\d{4}-\d{2}-\d{2}T\d{2}$/),
    });
  });

  it('records only the bookings a digest listed, and lists the rest first next time', async () => {
    // 25 bookings waiting: Monday 09:00–15:00 every 15 min (seeded straight into the database).
    const patientId = uuidv7();
    await env.DB.prepare(
      "INSERT INTO patients (id, name, phone_e164, version, updated_at) VALUES (?, 'Many', '+251911999999', 1, 0)",
    )
      .bind(patientId)
      .run();
    for (let i = 0; i < 25; i++) {
      await env.DB.prepare(
        `INSERT INTO bookings (id, patient_id, start_at, duration_min, status, created_by, version, updated_at)
         VALUES (?, ?, ?, 15, 'pending_approval', ?, 1, 0)`,
      )
        .bind(uuidv7(), patientId, at(monday(), 9, i * 15), staff.user.id)
        .run();
    }
    const telegram = new FakeTelegram();
    const morning = addDays(sunday(), -2);
    await runHourly(env, at(morning, 8), telegram);
    const first = telegram.to(DOCTOR_CHAT, '25 bookings waiting');
    expect(first).toHaveLength(1);
    expect(first[0]!.message.text).toContain('…and 5 more');
    const items = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notification_log WHERE kind = 'digest_item'",
    ).first<{ n: number }>();
    expect(items?.n).toBe(20);
    // Next hour: the 5 not yet shown come first (14:00 onwards).
    await runHourly(env, at(morning, 9), telegram);
    const second = telegram.to(DOCTOR_CHAT, '25 bookings waiting');
    expect(second).toHaveLength(2);
    expect(second[1]!.message.text.split(String.fromCharCode(10))[1]).toContain('14:00');
  });

  it('sends no digest at night', async () => {
    await staffBooking(10);
    const telegram = new FakeTelegram();
    await runHourly(env, at(addDays(sunday(), -2), 6), telegram);
    await runHourly(env, at(addDays(sunday(), -2), 22), telegram);
    expect(telegram.to(DOCTOR_CHAT, '1 bookings waiting')).toHaveLength(0);
  });

  it("sends the Doctor tomorrow's summary from 19:00, once, and only before an open day", async () => {
    await staffBooking(10);
    const telegram = new FakeTelegram();
    await runHourly(env, at(sunday(), 18), telegram);
    expect(telegram.to(DOCTOR_CHAT, 'Tomorrow')).toHaveLength(0);
    await runHourly(env, at(sunday(), 19), telegram);
    await runHourly(env, at(sunday(), 20), telegram);
    const summaries = telegram.to(DOCTOR_CHAT, 'Tomorrow');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.message.text).toContain('Abebe Kebede');
    expect(telegram.to(STAFF_CHAT, 'Tomorrow')).toHaveLength(0);
    // Saturday 19:00: Sunday is closed, so no summary.
    await runHourly(env, at(addDays(sunday(), -1), 19), telegram);
    expect(telegram.to(DOCTOR_CHAT, 'Tomorrow')).toHaveLength(1);
  });

  it('sends the team the call list from 18:00, once a day', async () => {
    await staffBooking(10);
    const telegram = new FakeTelegram();
    await runHourly(env, at(sunday(), 18), telegram);
    await runHourly(env, at(sunday(), 19), telegram);
    for (const chat of [DOCTOR_CHAT, STAFF_CHAT]) {
      const lists = telegram.to(chat, '📞 Call list: 1');
      expect(lists).toHaveLength(1);
      expect(lists[0]!.message.text).toContain('📵');
    }
  });

  it('retries a failed send the next hour, and never sends twice', async () => {
    await staffBooking(10);
    const telegram = new FakeTelegram();
    telegram.failNext = 10;
    await runHourly(env, at(sunday(), 19), telegram);
    expect(telegram.to(DOCTOR_CHAT, 'Tomorrow')).toHaveLength(0);
    telegram.failNext = 0;
    await runHourly(env, at(sunday(), 20), telegram);
    await runHourly(env, at(sunday(), 21), telegram);
    expect(telegram.to(DOCTOR_CHAT, 'Tomorrow')).toHaveLength(1);
    const log = await env.DB.prepare(
      "SELECT status FROM notification_log WHERE kind = 'tomorrow_summary'",
    ).all();
    expect(log.results.every((r) => r.status === 'sent')).toBe(true);
  });

  it('sends nothing to team members who did not link Telegram', async () => {
    await env.DB.prepare('UPDATE users SET telegram_chat_id = NULL WHERE id = ?').bind(staff.user.id).run();
    await staffBooking(10);
    const telegram = new FakeTelegram();
    await runHourly(env, at(sunday(), 19), telegram);
    expect(telegram.sent.filter((s) => s.chatId === STAFF_CHAT)).toHaveLength(0);
  });

  it('does nothing without a bot token', async () => {
    const withoutToken = (): Env => {
      const { TEAM_BOT_TOKEN: _, ...rest } = env;
      return rest;
    };
    await staffBooking(10);
    await expect(runHourly(withoutToken(), at(sunday(), 19))).resolves.toBeUndefined();
    const log = await env.DB.prepare('SELECT COUNT(*) AS n FROM notification_log').first<{ n: number }>();
    expect(log?.n).toBe(0);
  });
});
