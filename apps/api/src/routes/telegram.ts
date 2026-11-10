/**
 * The Yegna Team bot (PRD §13) and Telegram linking from the PWA.
 *
 * - `GET /me/telegram`, `POST /me/telegram/link`, `DELETE /me/telegram` (signed-in device):
 *   whether the user's Telegram is linked; a one-time code (10 min, stored hashed) that opens
 *   `t.me/<bot>?start=<code>`; unlinking.
 * - `POST /telegram/team`: the webhook. The secret header is checked first (PRD §18). Only
 *   private chats of linked, enabled team members are served, looked up at each update; anyone
 *   else gets one generic refusal. Approving from the bot goes through the same op logic as the
 *   PWA's sync, and only for bookings shown in that message and unchanged since.
 */
import { and, eq, isNull, like } from 'drizzle-orm';
import { Api, Bot, type Context as BotContext, type Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { Hono } from 'hono';
import { bookings, notificationLog, patients, telegramLinkCodes, users } from '@yegna/db';
import { type SessionUser, type SyncOp, uuidv7 } from '@yegna/shared';
import { addDays, localDateOf, localToUtc } from '@yegna/time';
import { auditInsert } from '../lib/audit.ts';
import { randomHex, safeEqual, sha256Hex } from '../lib/crypto.ts';
import type { Db } from '../lib/db.ts';
import { type AppEnv, fail } from '../lib/http.ts';
import type { QueryMeter } from '../lib/queryMeter.ts';
import { requireDevice, requireDoctor } from '../lib/session.ts';
import { bookingLinesBetween } from '../jobs/team.ts';
import { type Recipient, botText, daySchedule } from '../notify/messages.ts';
import { sendErrorKind } from '../notify/notifier.ts';
import { MAX_QUERIES_PER_OP, applyOp } from '../sync/apply.ts';

export const LINK_CODE_TTL_MS = 10 * 60_000;
/** Device id recorded for changes made from the bot (sync_ops, audit_log). */
export const BOT_DEVICE_ID = 'telegram-team-bot';

export const telegram = new Hono<AppEnv>();

// ---------------------------------------------------------------------------------------------
// Linking from the PWA

telegram.get('/me/telegram', requireDevice, async (c) => {
  const row = await c
    .get('db')
    .select({ chatId: users.telegramChatId })
    .from(users)
    .where(eq(users.id, c.get('session').user.id))
    .get();
  return c.json({ linked: Boolean(row?.chatId), available: botConfigured(c.env) });
});

telegram.post('/me/telegram/link', requireDevice, async (c) => {
  if (!botConfigured(c.env)) return fail(c, 503, 'not_configured');
  const db = c.get('db');
  const session = c.get('session');
  const now = Date.now();
  const code = randomHex(16);
  await db.batch([
    // One live code per user: a new one replaces the old.
    db.delete(telegramLinkCodes).where(eq(telegramLinkCodes.userId, session.user.id)),
    db.insert(telegramLinkCodes).values({
      codeHash: await sha256Hex(code),
      userId: session.user.id,
      expiresAt: now + LINK_CODE_TTL_MS,
    }),
  ]);
  return c.json({
    url: `https://t.me/${c.env.TEAM_BOT_USERNAME}?start=${code}`,
    expiresAt: now + LINK_CODE_TTL_MS,
  });
});

telegram.delete('/me/telegram', requireDevice, async (c) => {
  const db = c.get('db');
  const session = c.get('session');
  await db.batch([
    db.update(users).set({ telegramChatId: null }).where(eq(users.id, session.user.id)),
    auditInsert(db, session, 'users', session.user.id, 'telegram_unlink', null, Date.now()),
  ]);
  return c.json({ linked: false });
});

/**
 * Doctor only: points the bot's webhook at this API (with the secret) and sets its command list.
 * Run once after the bot's secrets are stored, and again after rotating them (runbook).
 */
telegram.post('/admin/telegram/connect', requireDevice, requireDoctor, async (c) => {
  if (!botConfigured(c.env)) return fail(c, 503, 'not_configured');
  const api = new Api(c.env.TEAM_BOT_TOKEN!);
  try {
    await api.setWebhook(`${new URL(c.req.url).origin}/telegram/team`, {
      secret_token: c.env.TEAM_BOT_WEBHOOK_SECRET!,
      allowed_updates: ['message', 'callback_query'],
    });
    await api.setMyCommands([
      { command: 'today', description: 'Today / ዛሬ' },
      { command: 'tomorrow', description: 'Tomorrow / ነገ' },
    ]);
  } catch (err) {
    console.error('team_bot_connect_failed', sendErrorKind(err));
    return c.json({ error: 'server_error' }, 502);
  }
  await auditInsert(c.get('db'), c.get('session'), 'telegram', 'team_bot', 'connect', null, Date.now());
  return c.json({ ok: true });
});

function botConfigured(env: Env): boolean {
  return Boolean(env.TEAM_BOT_TOKEN && env.TEAM_BOT_USERNAME && env.TEAM_BOT_WEBHOOK_SECRET);
}

// ---------------------------------------------------------------------------------------------
// The webhook

telegram.post('/telegram/team', async (c) => {
  const secret = c.env.TEAM_BOT_WEBHOOK_SECRET;
  const given = c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!secret || !c.env.TEAM_BOT_TOKEN || !safeEqual(given, secret)) return fail(c, 401, 'unauthorized');
  let update: unknown;
  try {
    update = await c.req.json();
  } catch {
    return fail(c, 400, 'bad_request');
  }
  try {
    await teamBot(c.env, c.get('db'), c.get('meter')).handleUpdate(update as never);
  } catch (err) {
    // Error type only (PRD §18). Telegram retries non-2xx webhooks; a handler error must not
    // make it resend the update.
    console.error('team_bot_failed', err instanceof Error ? err.name : 'unknown');
  }
  return c.json({ ok: true });
});

/** Test hooks: answer the Bot API calls handlers make, and fix the time. */
export interface BotOptions {
  apiTransformer?: Transformer;
  now?: number;
}

type Member = Recipient & { user: SessionUser };

/** The bot for one update; handlers close over this request's database and query meter. */
export function teamBot(env: Env, db: Db, meter: QueryMeter, options: BotOptions = {}): Bot {
  const token = env.TEAM_BOT_TOKEN!;
  // Given up front, so the bot never calls getMe.
  const botInfo = {
    id: Number(token.split(':')[0]),
    is_bot: true,
    first_name: 'Yegna Team',
    username: env.TEAM_BOT_USERNAME ?? 'yegna_team_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as UserFromGetMe;
  const bot = new Bot(token, { botInfo });
  if (options.apiTransformer) bot.api.config.use(options.apiTransformer);
  const now = () => options.now ?? Date.now();

  // Private chats only: a group could otherwise be linked and every member would see patient
  // names (groups and channels are ignored entirely).
  const chats = bot.chatType('private');

  chats.command('start', async (ctx) => {
    const code = ctx.match.trim();
    if (code) return link(ctx, code);
    const member = await memberFor(ctx);
    await ctx.reply(member ? botText.help(member) : botText.notLinked);
  });

  for (const which of ['today', 'tomorrow'] as const) {
    chats.command(which, async (ctx) => {
      const member = await memberFor(ctx);
      if (!member) return void (await ctx.reply(botText.notLinked));
      const today = localDateOf(now());
      const date = which === 'today' ? today : addDays(today, 1);
      const lines = await bookingLinesBetween(db, localToUtc(date, 0), localToUtc(addDays(date, 1), 0));
      await ctx.reply(daySchedule(member, which, date, lines));
    });
  }

  // "Approve" on an alert or digest line: that booking, at the version shown.
  chats.callbackQuery(/^approve:([0-9a-f-]{36}):(\d+)$/, async (ctx) => {
    const doctor = await doctorFor(ctx);
    if (!doctor) return void (await ctx.answerCallbackQuery({ text: botText.refused }));
    const { done, skipped } = await approve(doctor, [{ id: ctx.match[1]!, version: Number(ctx.match[2]) }]);
    await ctx.answerCallbackQuery({ text: botText.approved(doctor, done, skipped) });
  });

  // "Approve listed" on a digest: only the bookings that digest listed to this chat.
  chats.callbackQuery(/^all:(\d{4}-\d{2}-\d{2}T\d{2})$/, async (ctx) => {
    const doctor = await doctorFor(ctx);
    if (!doctor) return void (await ctx.answerCallbackQuery({ text: botText.refused }));
    const rows = await db
      .select({ key: notificationLog.bookingId })
      .from(notificationLog)
      .where(
        and(
          eq(notificationLog.kind, 'digest_item'),
          eq(notificationLog.targetChatId, doctor.chatId),
          like(notificationLog.bookingId, `${ctx.match[1]}|%`),
        ),
      )
      .all();
    const listed = rows.map((r) => {
      const [, id, version] = r.key.split('|');
      return { id: id!, version: Number(version) };
    });
    const { done, skipped, unfinished } = await approve(doctor, listed);
    await ctx.answerCallbackQuery({
      text: unfinished ? botText.approvedMore(doctor, done) : botText.approved(doctor, done, skipped),
    });
  });

  chats.on('callback_query:data', (ctx) => ctx.answerCallbackQuery({ text: botText.refused }));

  // Any other message: help for the team, the refusal for everyone else (PRD §13).
  chats.on('message', async (ctx) => {
    const member = await memberFor(ctx);
    await ctx.reply(member ? botText.help(member) : botText.notLinked);
  });

  /** The linked, enabled team member writing from this private chat (looked up now). */
  async function memberFor(ctx: BotContext): Promise<Member | null> {
    // In a private chat the sender is the chat; anything else (e.g. a forwarded button) is refused.
    if (!ctx.chat || !ctx.from || ctx.from.id !== ctx.chat.id) return null;
    const chatId = String(ctx.chat.id);
    const row = await db
      .select({
        id: users.id,
        name: users.name,
        role: users.role,
        locale: users.locale,
        calendar: users.calendar,
      })
      .from(users)
      .where(and(eq(users.telegramChatId, chatId), isNull(users.disabledAt), isNull(users.deletedAt)))
      .get();
    return row ? { chatId, role: row.role, locale: row.locale, calendar: row.calendar, user: row } : null;
  }

  async function doctorFor(ctx: BotContext): Promise<Member | null> {
    const member = await memberFor(ctx);
    return member?.role === 'doctor' ? member : null;
  }

  async function link(ctx: BotContext, code: string) {
    const chatId = String(ctx.chat!.id);
    const found = await db
      .select({ userId: telegramLinkCodes.userId, expiresAt: telegramLinkCodes.expiresAt })
      .from(telegramLinkCodes)
      .where(eq(telegramLinkCodes.codeHash, await sha256Hex(code)))
      .get();
    const user =
      found && found.expiresAt > now() && ctx.from?.id === ctx.chat!.id
        ? await db
            .select({
              id: users.id,
              name: users.name,
              role: users.role,
              locale: users.locale,
              calendar: users.calendar,
            })
            .from(users)
            .where(and(eq(users.id, found.userId), isNull(users.disabledAt), isNull(users.deletedAt)))
            .get()
        : undefined;
    if (!user) {
      await ctx.reply(botText.linkFailed);
      return;
    }
    await db.batch([
      // The code is used up; a chat belongs to one account at a time.
      db.delete(telegramLinkCodes).where(eq(telegramLinkCodes.userId, user.id)),
      db.update(users).set({ telegramChatId: null }).where(eq(users.telegramChatId, chatId)),
      db.update(users).set({ telegramChatId: chatId }).where(eq(users.id, user.id)),
      auditInsert(db, { deviceId: BOT_DEVICE_ID, user }, 'users', user.id, 'telegram_link', null, now()),
    ]);
    await ctx.reply(botText.linked({ chatId, ...user }, user.name));
  }

  /**
   * Approves each booking that is unchanged since it was shown (same version), still waiting,
   * still ahead and whose patient is not erased; through the sync op logic, so the rules, clash
   * check, new version and audit are those of the PWA. Already approved counts as done (a double
   * tap). Stops when the request's query budget runs low (`unfinished`).
   */
  async function approve(doctor: Member, shown: { id: string; version: number }[]) {
    let done = 0;
    let skipped = 0;
    for (const [i, item] of shown.entries()) {
      if (meter.remaining() < MAX_QUERIES_PER_OP + 3) return { done, skipped, unfinished: i < shown.length };
      const row = await db
        .select({
          version: bookings.version,
          status: bookings.status,
          startAt: bookings.startAt,
          approvedBy: bookings.approvedBy,
          patientDeletedAt: patients.deletedAt,
        })
        .from(bookings)
        .innerJoin(patients, eq(patients.id, bookings.patientId))
        .where(and(eq(bookings.id, item.id), isNull(bookings.deletedAt)))
        .get();
      if (row?.status === 'approved' && row.approvedBy === doctor.user.id) {
        done++;
        continue;
      }
      const unchanged =
        row &&
        row.version === item.version &&
        row.status === 'pending_approval' &&
        row.startAt > now() &&
        row.patientDeletedAt === null;
      if (!unchanged) {
        skipped++;
        continue;
      }
      const op: SyncOp = {
        opId: uuidv7(now()),
        entity: 'bookings',
        entityId: item.id,
        kind: 'update',
        fields: { status: 'approved' },
        baseVersion: item.version,
        at: now(),
        userId: doctor.user.id,
      };
      const result = await applyOp(
        { db, session: { user: doctor.user, deviceId: BOT_DEVICE_ID }, now: now() },
        op,
      );
      if (result?.outcome === 'applied') done++;
      else skipped++;
    }
    return { done, skipped, unfinished: false };
  }

  return bot;
}
