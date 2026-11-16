/**
 * The Yegna Dental patient bot (PRD §14): information and appointment messages. **No booking
 * requests** (bookings happen by phone).
 *
 * - `POST /telegram/patient`: the webhook; the secret header is checked first (PRD §18).
 * - `POST /admin/telegram/patient/connect` (Doctor): points the bot's webhook here.
 *
 * Linking: the patient shares their own contact (`contact.user_id === from.id`, so nobody can
 * link someone else's number) and it must match a live patient's phone. A stranger learns only
 * whether their own number is booked. Nothing is stored about chats that are not linked; the
 * menu's language is carried by the button texts themselves.
 *
 * A patient sees only their own approved bookings, never notes, other patients or free times.
 */
import { and, asc, eq, gt, isNull, ne } from 'drizzle-orm';
import { Api, Bot, type Context as BotContext, type Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { Hono } from 'hono';
import { auditLog, bookings, patientRequests, patients, procedures, settings } from '@yegna/db';
import { CLINIC, SETTINGS_ID, mapsUrl, normalizePhone, uuidv7 } from '@yegna/shared';
import { DEFAULT_WEEKLY_HOURS, type WeeklyDefaults } from '@yegna/time';
import { auditInsert } from '../lib/audit.ts';
import { safeEqual } from '../lib/crypto.ts';
import { CURRENT_VERSION, type Db, withVersion } from '../lib/db.ts';
import { type AppEnv, fail } from '../lib/http.ts';
import { requireDevice, requireDoctor } from '../lib/session.ts';
import { linkedTeam } from '../jobs/team.ts';
import { deliverOnce } from '../notify/deliver.ts';
import { patientRequestAlert } from '../notify/messages.ts';
import { type Notifier, TELEGRAM_CLIENT, sendErrorKind, telegramNotifier } from '../notify/notifier.ts';
import {
  type MenuItem,
  type PatientBooking,
  type PatientLocale,
  REQUEST_ACTIONS,
  hoursText,
  keyboards,
  languageOf,
  menuItemOf,
  patientText,
  whenAndWhat,
} from '../notify/patientMessages.ts';

/** Device id recorded for changes made from the patient bot (audit_log). */
export const PATIENT_BOT_DEVICE_ID = 'telegram-patient-bot';
/** Bookings listed under "My appointment". */
const MAX_LISTED = 5;

export const patientBotRoutes = new Hono<AppEnv>();

function configured(env: Env): boolean {
  return Boolean(env.PATIENT_BOT_TOKEN && env.PATIENT_BOT_WEBHOOK_SECRET);
}

/** Doctor only: whether the patient bot is set up, and its public link (to share with patients). */
patientBotRoutes.get('/admin/telegram/patient', requireDevice, requireDoctor, (c) =>
  c.json({
    available: configured(c.env),
    url: c.env.PATIENT_BOT_USERNAME ? `https://t.me/${c.env.PATIENT_BOT_USERNAME}` : null,
  }),
);

patientBotRoutes.post('/admin/telegram/patient/connect', requireDevice, requireDoctor, async (c) => {
  if (!configured(c.env)) return fail(c, 503, 'not_configured');
  const api = new Api(c.env.PATIENT_BOT_TOKEN!, TELEGRAM_CLIENT);
  try {
    await api.setWebhook(`${new URL(c.req.url).origin}/telegram/patient`, {
      secret_token: c.env.PATIENT_BOT_WEBHOOK_SECRET!,
      allowed_updates: ['message', 'callback_query'],
    });
    await api.setMyCommands([{ command: 'start', description: 'ማውጫ / Menu' }]);
  } catch (err) {
    console.error('patient_bot_connect_failed', sendErrorKind(err));
    return c.json({ error: 'server_error' }, 502);
  }
  await auditInsert(c.get('db'), c.get('session'), 'telegram', 'patient_bot', 'connect', null, Date.now());
  return c.json({ ok: true });
});

patientBotRoutes.post('/telegram/patient', async (c) => {
  const secret = c.env.PATIENT_BOT_WEBHOOK_SECRET;
  const given = c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!secret || !c.env.PATIENT_BOT_TOKEN || !safeEqual(given, secret)) return fail(c, 401, 'unauthorized');
  let update: unknown;
  try {
    update = await c.req.json();
  } catch {
    return fail(c, 400, 'bad_request');
  }
  try {
    const teamToken = c.env.TEAM_BOT_TOKEN;
    await patientBot(c.env, c.get('db'), {
      ...(teamToken ? { team: telegramNotifier(teamToken) } : {}),
      waitUntil: (work) => c.executionCtx.waitUntil(work),
    }).handleUpdate(update as never);
  } catch (err) {
    // Error type only (PRD §18); a 2xx keeps Telegram from resending the update.
    console.error('patient_bot_failed', err instanceof Error ? err.name : 'unknown');
  }
  return c.json({ ok: true });
});

export interface PatientBotOptions {
  apiTransformer?: Transformer;
  now?: number;
  /** The team bot, for alerts about patient requests (absent: no alert, the call list still has it). */
  team?: Notifier;
  waitUntil?: (work: Promise<unknown>) => void;
}

interface Linked {
  id: string;
  locale: PatientLocale | null;
}

export function patientBot(env: Env, db: Db, options: PatientBotOptions = {}): Bot {
  const token = env.PATIENT_BOT_TOKEN!;
  const botInfo = {
    id: Number(token.split(':')[0]),
    is_bot: true,
    first_name: CLINIC.name.en,
    username: env.PATIENT_BOT_USERNAME ?? 'yegna_dental_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as UserFromGetMe;
  const bot = new Bot(token, { botInfo, client: TELEGRAM_CLIENT });
  if (options.apiTransformer) bot.api.config.use(options.apiTransformer);
  const now = () => options.now ?? Date.now();
  const later = (work: Promise<unknown>) => {
    const safe = work.catch((err: unknown) =>
      console.error('patient_request_alert_failed', err instanceof Error ? err.name : 'unknown'),
    );
    if (options.waitUntil) options.waitUntil(safe);
    else return safe;
  };

  // Private chats only, and only from the chat's own user (no forwarded buttons, no groups).
  const chats = bot.chatType('private').filter((ctx) => ctx.from?.id === ctx.chat.id);

  chats.command('start', (ctx) =>
    ctx.reply(patientText.chooseLanguage(), { reply_markup: keyboards.language() }),
  );

  chats.on('message:contact', async (ctx) => {
    const linked = await linkedPatient(ctx);
    const locale: PatientLocale = linked?.locale ?? (ctx.from.language_code === 'en' ? 'en' : 'am');
    const contact = ctx.message.contact;
    if (contact.user_id !== ctx.from.id) {
      return void (await ctx.reply(patientText.notOwnContact(locale), {
        reply_markup: keyboards.shareContact(locale),
      }));
    }
    const phone = normalizePhone(contact.phone_number);
    const patient = phone.ok
      ? await db
          .select({ id: patients.id })
          .from(patients)
          .where(and(eq(patients.phoneE164, phone.e164), isNull(patients.deletedAt)))
          .get()
      : undefined;
    if (!patient) {
      return void (await ctx.reply(patientText.notFound(locale), { reply_markup: keyboards.menu(locale) }));
    }
    const chatId = String(ctx.chat.id);
    const at = now();
    await withVersion(
      db,
      // A chat belongs to one patient: an earlier link of this chat ends (new version, so the
      // PWA's 📵 flag updates too).
      db
        .update(patients)
        .set({
          telegramChatId: null,
          telegramLinkedAt: null,
          telegramLocale: null,
          version: CURRENT_VERSION,
          updatedAt: at,
        })
        .where(and(eq(patients.telegramChatId, chatId), ne(patients.id, patient.id))),
      db
        .update(patients)
        .set({
          telegramChatId: chatId,
          telegramLinkedAt: at,
          telegramLocale: locale,
          version: CURRENT_VERSION,
          updatedAt: at,
        })
        .where(eq(patients.id, patient.id)),
      botAudit('patients', patient.id, 'telegram_link', at),
    );
    await ctx.reply(patientText.linked(locale), { reply_markup: keyboards.menu(locale) });
    await ctx.reply(await appointmentsText(patient.id, locale));
  });

  chats.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const chosen = languageOf(text);
    if (chosen) {
      await rememberLocale(ctx, chosen);
      return void (await ctx.reply(patientText.welcome(chosen), { reply_markup: keyboards.menu(chosen) }));
    }
    const menu = menuItemOf(text);
    if (!menu) {
      const linked = await linkedPatient(ctx);
      if (linked?.locale) {
        return void (await ctx.reply(patientText.welcome(linked.locale), {
          reply_markup: keyboards.menu(linked.locale),
        }));
      }
      return void (await ctx.reply(patientText.chooseLanguage(), { reply_markup: keyboards.language() }));
    }
    await answerMenu(ctx, menu.item, menu.locale);
  });

  chats.on('message', (ctx) =>
    ctx.reply(patientText.chooseLanguage(), { reply_markup: keyboards.language() }),
  );

  // Reminder buttons: ✅ Confirm · 🔁 Need to reschedule · ❌ Cancel (PRD §14).
  chats.callbackQuery(/^p:([crx]):([0-9a-f-]{36}):(\d+)$/, async (ctx) => {
    const action = REQUEST_ACTIONS[ctx.match[1] as keyof typeof REQUEST_ACTIONS];
    const linked = await linkedPatient(ctx);
    const locale: PatientLocale = linked?.locale ?? 'am';
    const booking = linked
      ? await db
          .select({
            id: bookings.id,
            startAt: bookings.startAt,
            confirmedAt: bookings.patientConfirmedAt,
            procedureCode: procedures.code,
            patientName: patients.name,
            version: bookings.version,
          })
          .from(bookings)
          .innerJoin(patients, eq(patients.id, bookings.patientId))
          .leftJoin(procedures, eq(procedures.id, bookings.procedureId))
          .where(
            and(
              eq(bookings.id, ctx.match[2]!),
              // The time the reminder showed: a moved booking's old buttons do nothing.
              eq(bookings.startAt, Number(ctx.match[3])),
              eq(bookings.patientId, linked.id),
              eq(bookings.status, 'approved'),
              gt(bookings.startAt, now()),
              isNull(bookings.deletedAt),
            ),
          )
          .get()
      : undefined;
    if (!linked || !booking) {
      await ctx.answerCallbackQuery();
      return void (await ctx.reply(patientText.notAvailable(locale)));
    }
    const at = now();
    if (action === 'confirm') {
      if (booking.confirmedAt === null) {
        await withVersion(
          db,
          db
            .update(bookings)
            .set({ patientConfirmedAt: at, version: CURRENT_VERSION, updatedAt: at })
            .where(and(eq(bookings.id, booking.id), isNull(bookings.patientConfirmedAt))),
          botAudit('bookings', booking.id, 'patient_confirm', at),
        );
      }
      await ctx.answerCallbackQuery();
      return void (await ctx.reply(patientText.thanksConfirmed(locale)));
    }
    // Reschedule or cancel: one request per booking and kind, ever (handled or not), so repeated
    // taps never alert the team twice; the team is told to call.
    const open = await db
      .select({ id: patientRequests.id })
      .from(patientRequests)
      .where(
        and(
          eq(patientRequests.bookingId, booking.id),
          eq(patientRequests.kind, action),
          isNull(patientRequests.deletedAt),
        ),
      )
      .get();
    if (!open) {
      const requestId = uuidv7(at);
      await withVersion(
        db,
        db.insert(patientRequests).values({
          id: requestId,
          bookingId: booking.id,
          patientId: linked.id,
          kind: action,
          status: 'open',
          version: CURRENT_VERSION,
          updatedAt: at,
          updatedBy: null,
        }),
        botAudit('patient_requests', requestId, 'create', at),
      );
      if (options.team) {
        const team = options.team;
        const line = {
          id: booking.id,
          version: booking.version,
          patientName: booking.patientName,
          startAt: booking.startAt,
          procedureCode: booking.procedureCode,
        };
        await later(
          linkedTeam(db).then(async (members) => {
            for (const r of members) {
              await deliverOnce(
                db,
                team,
                { kind: 'patient_request', key: requestId, chatId: r.chatId },
                () => patientRequestAlert(r, line, action, env.PWA_ORIGIN),
                at,
              );
            }
          }),
        );
      }
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(patientText.willCall(locale));
  });

  chats.on('callback_query:data', (ctx) => ctx.answerCallbackQuery());

  async function answerMenu(ctx: BotContext, item: MenuItem, locale: PatientLocale) {
    const menu = { reply_markup: keyboards.menu(locale) };
    switch (item) {
      case 'language':
        return void (await ctx.reply(patientText.chooseLanguage(), { reply_markup: keyboards.language() }));
      case 'back':
        return void (await ctx.reply(patientText.welcome(locale), menu));
      case 'location':
        await ctx.replyWithLocation(CLINIC.geo.latitude, CLINIC.geo.longitude);
        return void (await ctx.reply(patientText.address(locale), {
          reply_markup: { inline_keyboard: [[{ text: patientText.openMaps(locale), url: mapsUrl() }]] },
        }));
      case 'hours':
        return void (await ctx.reply(hoursText(locale, await weeklyHours()), menu));
      case 'call':
        await ctx.replyWithContact(CLINIC.phones[0], CLINIC.name[locale]);
        return void (await ctx.reply(patientText.call(locale), menu));
      case 'services':
        return void (await ctx.reply(patientText.services(locale), menu));
      case 'appointment': {
        const linked = await linkedPatient(ctx);
        if (!linked) {
          return void (await ctx.reply(patientText.askContact(locale), {
            reply_markup: keyboards.shareContact(locale),
          }));
        }
        await rememberLocale(ctx, locale, linked);
        return void (await ctx.reply(await appointmentsText(linked.id, locale), menu));
      }
    }
  }

  /** The live patient linked to this chat, looked up at each update. */
  async function linkedPatient(ctx: BotContext): Promise<Linked | null> {
    if (!ctx.chat) return null;
    const row = await db
      .select({ id: patients.id, locale: patients.telegramLocale })
      .from(patients)
      .where(and(eq(patients.telegramChatId, String(ctx.chat.id)), isNull(patients.deletedAt)))
      .get();
    return row ?? null;
  }

  /** A linked patient's messages follow the language they last chose (not synced: no version). */
  async function rememberLocale(ctx: BotContext, locale: PatientLocale, known?: Linked | null) {
    const linked = known ?? (await linkedPatient(ctx));
    if (linked && linked.locale !== locale) {
      await db.update(patients).set({ telegramLocale: locale }).where(eq(patients.id, linked.id)).run();
    }
  }

  async function appointmentsText(patientId: string, locale: PatientLocale): Promise<string> {
    const rows: PatientBooking[] = await db
      .select({
        id: bookings.id,
        startAt: bookings.startAt,
        procedureNameAm: procedures.nameAm,
        procedureNameEn: procedures.nameEn,
      })
      .from(bookings)
      .leftJoin(procedures, eq(procedures.id, bookings.procedureId))
      .where(
        and(
          eq(bookings.patientId, patientId),
          // Only approved bookings: a patient is never told of one the Doctor has not approved.
          eq(bookings.status, 'approved'),
          gt(bookings.startAt, now()),
          isNull(bookings.deletedAt),
        ),
      )
      .orderBy(asc(bookings.startAt))
      .limit(MAX_LISTED)
      .all();
    if (rows.length === 0) return patientText.noAppointment(locale);
    return [patientText.yourAppointments(locale), ...rows.map((b) => `• ${whenAndWhat(locale, b)}`)].join(
      '\n',
    );
  }

  async function weeklyHours(): Promise<WeeklyDefaults> {
    const row = await db
      .select({ weeklyHours: settings.weeklyHours })
      .from(settings)
      .where(eq(settings.id, SETTINGS_ID))
      .get();
    return row ? (JSON.parse(row.weeklyHours) as WeeklyDefaults) : DEFAULT_WEEKLY_HOURS;
  }

  function botAudit(entity: string, entityId: string, action: string, at: number) {
    return db.insert(auditLog).values({
      id: uuidv7(at),
      entity,
      entityId,
      userId: null,
      deviceId: PATIENT_BOT_DEVICE_ID,
      action,
      diff: null,
      at,
    });
  }

  return bot;
}
