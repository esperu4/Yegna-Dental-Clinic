/**
 * Free-tier usage alert (PRD §19, §21 decision 8): the Doctor is told at 50% and 80% of a free
 * limit, once a day per metric and level, with a fake Cloudflare GraphQL API.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { localDateOf, localToUtc } from '@yegna/time';
import { runHourly } from '../src/jobs/dispatch.ts';
import { FREE_LIMITS, type Usage, overLevels } from '../src/jobs/usage.ts';
import type { Notifier, OutgoingMessage } from '../src/notify/notifier.ts';
import { type Call, caller, createTestEnv, resetDb, setupDoctor } from './helpers.ts';

const DOCTOR_CHAT = '1001';
const USAGE = { CF_ACCOUNT_ID: 'acct-0123', CF_ANALYTICS_TOKEN: 'analytics-token' };

let env: Env;
let dispose: () => Promise<void>;
let call: Call;

class FakeTelegram implements Notifier {
  sent: { chatId: string; message: OutgoingMessage }[] = [];
  async send(chatId: string, message: OutgoingMessage) {
    this.sent.push({ chatId, message });
  }
}

/** A GraphQL answer with these totals (split over rows, as the API groups them). */
function graphql(usage: Partial<Usage>, init: { status?: number; errors?: unknown[] } = {}) {
  const requests: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const impl = async (input: string | URL | Request, options?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(options?.body)) as Record<string, unknown>,
      auth: new Headers(options?.headers).get('Authorization'),
    });
    if (init.status && init.status !== 200) return new Response('nope', { status: init.status });
    const half = (n = 0) => [n - Math.floor(n / 2), Math.floor(n / 2)];
    const [r1, r2] = half(usage.workerRequests);
    return Response.json({
      data: {
        viewer: {
          accounts: [
            {
              workers: [{ sum: { requests: r1 } }, { sum: { requests: r2 } }],
              d1: [{ sum: { rowsRead: usage.d1RowsRead ?? 0, rowsWritten: usage.d1RowsWritten ?? 0 } }],
              storage: [
                { max: { databaseSizeBytes: 1024 } },
                { max: { databaseSizeBytes: usage.d1StorageBytes ?? 0 } },
              ],
            },
          ],
        },
      },
      errors: init.errors ?? null,
    });
  };
  return { requests, impl: impl as typeof fetch };
}

const at = (hh: number) => localToUtc(localDateOf(Date.now()), hh * 60);

beforeAll(async () => {
  ({ env, dispose } = await createTestEnv(USAGE));
  call = caller(env);
});
afterAll(() => dispose());
beforeEach(async () => {
  await resetDb(env);
  const doctor = await setupDoctor(call);
  await env.DB.prepare("UPDATE users SET telegram_chat_id = ?, locale = 'en' WHERE id = ?")
    .bind(DOCTOR_CHAT, doctor.user.id)
    .run();
});
afterEach(() => vi.restoreAllMocks());

const usageMessages = (t: FakeTelegram) => t.sent.filter((s) => s.message.text.startsWith('⚠️ Free plan'));

describe('free-tier usage alert (PRD §19)', () => {
  it('sends nothing under 50%, and asks for the current UTC day with the token', async () => {
    const api = graphql({ d1RowsRead: FREE_LIMITS.d1RowsRead * 0.49, workerRequests: 1000 });
    const telegram = new FakeTelegram();
    await runHourly(env, at(10), telegram, undefined, undefined, api.impl);
    expect(usageMessages(telegram)).toHaveLength(0);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]!.url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(api.requests[0]!.auth).toBe('Bearer analytics-token');
    const vars = api.requests[0]!.body.variables as Record<string, string>;
    expect(vars.account).toBe('acct-0123');
    expect(vars.date).toBe(new Date(at(10)).toISOString().slice(0, 10));
  });

  it('tells the Doctor once at 50%, once more at 80%, even if run every hour', async () => {
    const telegram = new FakeTelegram();
    const half = graphql({ d1RowsWritten: FREE_LIMITS.d1RowsWritten * 0.55 });
    await runHourly(env, at(10), telegram, undefined, undefined, half.impl);
    await runHourly(env, at(11), telegram, undefined, undefined, half.impl);
    expect(usageMessages(telegram)).toHaveLength(1);
    expect(usageMessages(telegram)[0]!.chatId).toBe(DOCTOR_CHAT);
    expect(usageMessages(telegram)[0]!.message.text).toMatch(/database rows written reached 55%/);
    const high = graphql({ d1RowsWritten: FREE_LIMITS.d1RowsWritten * 0.9 });
    await runHourly(env, at(12), telegram, undefined, undefined, high.impl);
    await runHourly(env, at(13), telegram, undefined, undefined, high.impl);
    expect(usageMessages(telegram)).toHaveLength(2);
    expect(usageMessages(telegram)[1]!.message.text).toMatch(/90%/);
  });

  it('straight past 80% sends one message, not a 50% one after it', async () => {
    const telegram = new FakeTelegram();
    const api = graphql({ workerRequests: FREE_LIMITS.workerRequests * 0.85 });
    await runHourly(env, at(10), telegram, undefined, undefined, api.impl);
    await runHourly(env, at(11), telegram, undefined, undefined, api.impl);
    expect(usageMessages(telegram)).toHaveLength(1);
  });

  it('counts the largest database against the size limit', () => {
    const levels = overLevels({
      workerRequests: 0,
      d1RowsRead: 0,
      d1RowsWritten: 0,
      d1StorageBytes: FREE_LIMITS.d1StorageBytes * 0.6,
    });
    expect(levels).toEqual([{ metric: 'd1StorageBytes', level: 50, percent: 60 }]);
  });

  it('the database size, which never resets, is told once a month', async () => {
    const telegram = new FakeTelegram();
    const api = graphql({ d1StorageBytes: FREE_LIMITS.d1StorageBytes * 0.6 });
    await runHourly(env, at(10), telegram, undefined, undefined, api.impl);
    await runHourly(env, at(10) + 86_400_000, telegram, undefined, undefined, api.impl);
    // The second day may fall in the next month: at most one message per month.
    const months = new Set([at(10), at(10) + 86_400_000].map((t) => new Date(t).toISOString().slice(0, 7)));
    expect(usageMessages(telegram)).toHaveLength(months.size);
    expect(usageMessages(telegram)[0]!.message.text).toMatch(/database size reached 60%/);
  });

  it('only from 07:00 to 21:00, and never without its secrets', async () => {
    const telegram = new FakeTelegram();
    const api = graphql({ d1RowsRead: FREE_LIMITS.d1RowsRead * 0.7 });
    await runHourly(env, at(3), telegram, undefined, undefined, api.impl);
    expect(api.requests).toHaveLength(0);
    const saved = env.CF_ANALYTICS_TOKEN!;
    delete env.CF_ANALYTICS_TOKEN;
    try {
      await runHourly(env, at(10), telegram, undefined, undefined, api.impl);
    } finally {
      env.CF_ANALYTICS_TOKEN = saved;
    }
    expect(api.requests).toHaveLength(0);
    expect(usageMessages(telegram)).toHaveLength(0);
  });

  it('an API error or a GraphQL error is logged (status only) and sends nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const telegram = new FakeTelegram();
    await runHourly(env, at(10), telegram, undefined, undefined, graphql({}, { status: 403 }).impl);
    await runHourly(
      env,
      at(11),
      telegram,
      undefined,
      undefined,
      graphql({}, { errors: [{ message: 'x' }] }).impl,
    );
    expect(usageMessages(telegram)).toHaveLength(0);
    const logged = errors.mock.calls.filter((c) => c[0] === 'usage_check_failed').map((c) => c[1]);
    expect(logged).toEqual(['http_403', 'graphql_error']);
  });
});
