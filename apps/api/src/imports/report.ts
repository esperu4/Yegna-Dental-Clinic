/**
 * Reads an import and tells the uploader in Telegram (PRD §12 step 4, §13 "Import read / failed"):
 * counts and a link to the review screen, never the rows themselves.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { imports, users } from '@yegna/db';
import type { Db } from '../lib/db.ts';
import { importFailed, importRead } from '../notify/messages.ts';
import { type Notifier, sendErrorKind, telegramNotifier } from '../notify/notifier.ts';
import { type ProcessOutcome, processImport } from './process.ts';

/** Background reads stop here, so the import stays queued instead of being cut off (PRD §12). */
export const BACKGROUND_READ_MS = 25_000;

export const reviewUrl = (env: Env, importId: string) => `${env.PWA_ORIGIN}/#/imports/${importId}`;

export async function readAndReport(
  env: Env,
  db: Db,
  importId: string,
  options: { notifier?: Notifier; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<ProcessOutcome> {
  const outcome = await processImport(env, db, importId, {
    signal: options.signal ?? AbortSignal.timeout(BACKGROUND_READ_MS),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (outcome.status !== 'read' && outcome.status !== 'failed') return outcome;
  const notifier = options.notifier ?? (env.TEAM_BOT_TOKEN ? telegramNotifier(env.TEAM_BOT_TOKEN) : null);
  if (!notifier) return outcome;
  const uploader = await db
    .select({
      chatId: users.telegramChatId,
      role: users.role,
      locale: users.locale,
      calendar: users.calendar,
    })
    .from(imports)
    .innerJoin(users, eq(users.id, imports.uploadedBy))
    .where(and(eq(imports.id, importId), isNull(users.disabledAt), isNull(users.deletedAt)))
    .get();
  if (!uploader?.chatId) return outcome;
  const r = {
    chatId: uploader.chatId,
    role: uploader.role,
    locale: uploader.locale,
    calendar: uploader.calendar,
  };
  const url = reviewUrl(env, importId);
  try {
    await notifier.send(
      r.chatId,
      outcome.status === 'read' ? importRead(r, outcome.rows, outcome.unreadable, url) : importFailed(r, url),
    );
  } catch (err) {
    console.error('import_report_failed', sendErrorKind(err));
  }
  return outcome;
}
