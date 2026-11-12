/**
 * Imports (PRD §8 item 10, §12): photos of paper sheets, read by the free readers (ADR 0009) and
 * reviewed by a person. Online only: the review needs the photo, which stays on Telegram.
 *
 * - `GET /imports`: recent imports. `GET /imports/:id`: one import and its rows.
 * - `GET /imports/:id/photo`: the photo, streamed from Telegram (never stored by us).
 * - `POST /imports/:id/process`: read a queued import now (the Imports screen calls it).
 * - `POST /imports`: upload from the app; the Team bot posts the photo into the uploader's own
 *   chat to get Telegram's file id (decided 2026-11-11), then it is read in the background.
 * - `POST /imports/:id/confirm`: record the reviewer's decisions (bookings themselves come through
 *   `/sync`), mark the import reviewed and tell the Doctor about skipped duplicates.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { bookings, importRows, imports, users } from '@yegna/db';
import { uuidv7, uuidv7Schema } from '@yegna/shared';
import { auditInsert } from '../lib/audit.ts';
import { CURRENT_VERSION, withVersion } from '../lib/db.ts';
import { type AppEnv, fail, parseBody } from '../lib/http.ts';
import { requireDevice } from '../lib/session.ts';
import {
  MAX_PHOTO_BYTES,
  PHOTO_TYPES,
  PhotoUnavailable,
  looksLikePhoto,
  telegramPhoto,
} from '../imports/photo.ts';
import { IMPORTS_PER_USER_PER_DAY, importsToday } from '../imports/limits.ts';
import { readAndReport } from '../imports/report.ts';
import { skippedDuplicates } from '../notify/messages.ts';
import { sendErrorKind, telegramNotifier } from '../notify/notifier.ts';

export const importRoutes = new Hono<AppEnv>();
importRoutes.use('/imports', requireDevice);
importRoutes.use('/imports/*', requireDevice);

/** Photos uploaded from the app: JPEG, PNG or WebP, at most the size the readers take. */
const UPLOAD_TYPES: readonly string[] = PHOTO_TYPES;
export const MAX_UPLOAD_BYTES = MAX_PHOTO_BYTES;
const LIST_LIMIT = 30;

importRoutes.get('/imports', async (c) => {
  const db = c.get('db');
  const list = await db
    .select({
      id: imports.id,
      status: imports.status,
      template: imports.template,
      sheetId: imports.periodLabel,
      provider: imports.provider,
      createdAt: imports.createdAt,
      uploadedBy: users.name,
      rows: sql<number>`(SELECT COUNT(*) FROM import_rows r WHERE r.import_id = ${imports.id})`,
      toCheck: sql<number>`(SELECT COUNT(*) FROM import_rows r WHERE r.import_id = ${imports.id} AND (r.needs_check = 1 OR r.match = 'unreadable'))`,
    })
    .from(imports)
    .innerJoin(users, eq(users.id, imports.uploadedBy))
    .where(isNull(imports.deletedAt))
    .orderBy(desc(imports.createdAt))
    .limit(LIST_LIMIT)
    .all();
  return c.json(list);
});

importRoutes.get('/imports/:id', async (c) => {
  const db = c.get('db');
  const id = c.req.param('id');
  const head = await db
    .select({
      id: imports.id,
      status: imports.status,
      template: imports.template,
      sheetId: imports.periodLabel,
      provider: imports.provider,
      createdAt: imports.createdAt,
    })
    .from(imports)
    .where(and(eq(imports.id, id), isNull(imports.deletedAt)))
    .get();
  if (!head) return fail(c, 404, 'not_found');
  const rows = await db
    .select({
      id: importRows.id,
      dayText: importRows.dayText,
      timeText: importRows.timeText,
      nameText: importRows.nameText,
      phoneText: importRows.phoneText,
      codeText: importRows.codeText,
      confidence: importRows.confidence,
      match: importRows.match,
      decision: importRows.decision,
      startAt: importRows.startAt,
      patientId: importRows.patientId,
      duplicateOfId: importRows.duplicateOfId,
      needsCheck: importRows.needsCheck,
      // The booking made from this row, as the server stored it (never as a client said).
      bookingId: bookings.id,
    })
    .from(importRows)
    .leftJoin(bookings, eq(bookings.importRowId, importRows.id))
    .where(and(eq(importRows.importId, id), isNull(importRows.deletedAt)))
    .orderBy(importRows.startAt, importRows.id)
    .all();
  return c.json({ ...head, rows });
});

importRoutes.get('/imports/:id/photo', async (c) => {
  const row = await c
    .get('db')
    .select({ fileId: imports.telegramFileId })
    .from(imports)
    .where(and(eq(imports.id, c.req.param('id')), isNull(imports.deletedAt)))
    .get();
  if (!row) return fail(c, 404, 'not_found');
  try {
    const photo = await telegramPhoto(c.env, row.fileId);
    return new Response(photo.image, {
      headers: {
        'Content-Type': photo.mime,
        // A patient list: never kept by browsers or proxies.
        'Cache-Control': 'private, no-store',
        // Shown only as an image, never run (privacy review M2).
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    if (err instanceof PhotoUnavailable && err.reason === 'not_configured')
      return fail(c, 503, 'not_configured');
    if (err instanceof PhotoUnavailable && err.reason === 'not_found') return fail(c, 404, 'not_found');
    console.error('import_photo_failed', err instanceof Error ? err.name : 'unknown');
    return fail(c, 502, 'not_found');
  }
});

importRoutes.post('/imports/:id/process', async (c) => {
  const outcome = await readAndReport(c.env, c.get('db'), c.req.param('id'));
  if (outcome.status === 'not_found') return fail(c, 404, 'not_found');
  return c.json(outcome);
});

importRoutes.post('/imports', async (c) => {
  const session = c.get('session');
  const db = c.get('db');
  if (!c.env.TEAM_BOT_TOKEN) return fail(c, 503, 'not_configured');
  const type = (c.req.header('Content-Type') ?? '').split(';')[0]!.trim();
  if (!UPLOAD_TYPES.includes(type)) return fail(c, 400, 'bad_request');
  // The size must be declared, so an oversized body is refused before it is read.
  const declared = Number(c.req.header('Content-Length'));
  if (!Number.isFinite(declared) || declared <= 0) return fail(c, 411, 'bad_request');
  if (declared > MAX_UPLOAD_BYTES) return fail(c, 413, 'too_large');
  const me = await db
    .select({ chatId: users.telegramChatId })
    .from(users)
    .where(eq(users.id, session.user.id))
    .get();
  if (!me?.chatId) return fail(c, 409, 'telegram_not_linked');
  if ((await importsToday(db, session.user.id, Date.now())) >= IMPORTS_PER_USER_PER_DAY) {
    return fail(c, 429, 'locked');
  }
  const image = await c.req.arrayBuffer();
  if (image.byteLength > MAX_UPLOAD_BYTES) return fail(c, 413, 'too_large');
  if (!looksLikePhoto(new Uint8Array(image))) return fail(c, 400, 'bad_request');

  let fileId: string;
  try {
    fileId = await postToOwnChat(c.env.TEAM_BOT_TOKEN, me.chatId, image, type);
  } catch (err) {
    console.error('import_upload_failed', err instanceof Error ? err.name : 'unknown');
    return c.json({ error: 'server_error' }, 502);
  }
  const id = uuidv7();
  const now = Date.now();
  await withVersion(
    db,
    db.insert(imports).values({
      id,
      telegramFileId: fileId,
      uploadedBy: session.user.id,
      status: 'queued',
      createdAt: now,
      version: CURRENT_VERSION,
      // 0, not now: the background read below may claim it at once.
      updatedAt: 0,
      updatedBy: session.user.id,
    }),
    auditInsert(db, session, 'imports', id, 'create', { source: 'app' }, now),
  );
  c.executionCtx.waitUntil(readAndReport(c.env, db, id).catch(() => undefined));
  return c.json({ id }, 201);
});

/**
 * Posts an uploaded photo into the uploader's own chat with the Team bot and returns Telegram's
 * file id for it (we keep no copy of the photo, PRD §12). Errors carry the HTTP status only.
 */
async function postToOwnChat(
  token: string,
  chatId: string,
  image: ArrayBuffer,
  type: string,
): Promise<string> {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('photo', new Blob([image], { type }), 'sheet');
  form.append('caption', 'Yegna · import');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`telegram_${res.status}`);
  const body = (await res.json()) as { result?: { photo?: { file_id: string }[] } };
  const largest = body.result?.photo?.at(-1)?.file_id;
  if (!largest) throw new Error('telegram_no_photo');
  return largest;
}

const confirmRequest = z
  .object({
    rows: z
      .array(
        z
          .object({
            id: uuidv7Schema,
            decision: z.enum(['accept', 'skip']),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

importRoutes.post('/imports/:id/confirm', async (c) => {
  const body = await parseBody(c, confirmRequest);
  if (!body) return fail(c, 400, 'bad_request');
  const db = c.get('db');
  const session = c.get('session');
  const id = c.req.param('id');
  const head = await db
    .select({ status: imports.status })
    .from(imports)
    .where(and(eq(imports.id, id), isNull(imports.deletedAt)))
    .get();
  if (!head) return fail(c, 404, 'not_found');
  // Once: a reviewed import is not reviewed (nor reported to the Doctor) again.
  if (head.status !== 'read') return fail(c, 409, 'conflict');
  const known = await db
    .select({
      id: importRows.id,
      match: importRows.match,
      nameText: importRows.nameText,
      startAt: importRows.startAt,
      duplicateOfId: importRows.duplicateOfId,
    })
    .from(importRows)
    .where(and(eq(importRows.importId, id), isNull(importRows.deletedAt)))
    .all();
  const byId = new Map(known.map((r) => [r.id, r]));
  if (body.rows.some((r) => !byId.has(r.id))) return fail(c, 400, 'bad_request');

  const now = Date.now();
  await withVersion(
    db,
    ...body.rows.map((r) =>
      db
        .update(importRows)
        .set({
          decision: r.decision,
          version: CURRENT_VERSION,
          updatedAt: now,
          updatedBy: session.user.id,
        })
        .where(and(eq(importRows.id, r.id), eq(importRows.importId, id))),
    ),
    db
      .update(imports)
      .set({ status: 'reviewed', version: CURRENT_VERSION, updatedAt: now, updatedBy: session.user.id })
      .where(eq(imports.id, id)),
    auditInsert(
      db,
      session,
      'imports',
      id,
      'review',
      {
        accepted: body.rows.filter((r) => r.decision === 'accept').length,
        skipped: body.rows.filter((r) => r.decision === 'skip').length,
      },
      now,
    ),
  );

  // PRD §12 step 7: skipped duplicates are reported to the Doctor, with the existing booking.
  const skipped = body.rows
    .map((r) => byId.get(r.id)!)
    .filter(
      (r, i) => body.rows[i]!.decision === 'skip' && r.match === 'duplicate' && r.duplicateOfId && r.startAt,
    );
  if (skipped.length && c.env.TEAM_BOT_TOKEN) {
    c.executionCtx.waitUntil(reportSkipped(c.env, db, skipped).catch(() => undefined));
  }
  return c.json({ status: 'reviewed' });
});

async function reportSkipped(
  env: Env,
  db: AppEnv['Variables']['db'],
  skipped: { nameText: string | null; startAt: number | null; duplicateOfId: string | null }[],
) {
  const existing = await db
    .select({ id: bookings.id, startAt: bookings.startAt, by: users.name })
    .from(bookings)
    // PRD §12 step 7: "already booked … by Hana": who made the booking.
    .leftJoin(users, eq(users.id, bookings.createdBy))
    .where(
      inArray(
        bookings.id,
        skipped.map((s) => s.duplicateOfId!),
      ),
    )
    .all();
  const byId = new Map(existing.map((b) => [b.id, b]));
  const items = skipped.flatMap((s) => {
    const b = byId.get(s.duplicateOfId!);
    return b
      ? [{ name: s.nameText ?? '?', startAt: s.startAt!, existingAt: b.startAt, existingBy: b.by }]
      : [];
  });
  if (items.length === 0) return;
  const doctors = await db
    .select({ chatId: users.telegramChatId, locale: users.locale, calendar: users.calendar })
    .from(users)
    .where(and(eq(users.role, 'doctor'), isNull(users.disabledAt), isNull(users.deletedAt)))
    .all();
  const notifier = telegramNotifier(env.TEAM_BOT_TOKEN!);
  for (const d of doctors) {
    if (!d.chatId) continue;
    const r = { chatId: d.chatId, role: 'doctor' as const, locale: d.locale, calendar: d.calendar };
    try {
      await notifier.send(d.chatId, { text: skippedDuplicates(r, items) });
    } catch (err) {
      console.error('import_skipped_report_failed', sendErrorKind(err));
    }
  }
}
