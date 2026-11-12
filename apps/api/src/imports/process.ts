/**
 * Reading one import (PRD §12, ADR 0009): fetch the photo from Telegram (we keep only its file
 * id), run the reader chain, then match each row: the date and time from the sheet ID and the ET
 * time, the patient by phone (by name on template O, always to be checked), and duplicates of a
 * booking for the same patient within ±30 minutes (skipped by default).
 *
 * An import is claimed before reading, so the bot's background run and a later
 * `POST /imports/:id/process` never read the same photo twice at the same time.
 */
import { and, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import { PROMPT_VERSION, type ReadRow, type ReaderChain, type TemplateCode, readSchedule } from '@yegna/ai';
import { bookings, importRows, imports, patients, procedures, settings } from '@yegna/db';
import {
  DUPLICATE_WINDOW_MS,
  type SheetRef,
  SETTINGS_ID,
  isActiveStatus,
  isDuplicate,
  nameSimilarity,
  normalizePhone,
  parseSheetId,
  rowStart,
  sheetPeriod,
  uuidv7,
} from '@yegna/shared';
import { addDays, localToUtc } from '@yegna/time';
import { CURRENT_VERSION, type Db, withVersion } from '../lib/db.ts';
import { parseWeekly } from '../sync/bookings.ts';
import { LAST_RESORT_READS_PER_DAY, lastResortReadsToday } from './limits.ts';
import { readerChain } from './readers.ts';
import { telegramPhoto } from './photo.ts';

/** A claim lasts this long; a run that died is retried after it. */
export const CLAIM_MS = 90_000;
/** Name-only matches on template O at or above this are offered as the existing patient. */
export const NAME_MATCH_MIN = 0.85;
/** Rows read with less confidence are flagged for a person to check. */
export const LOW_CONFIDENCE = 0.6;

export type ProcessOutcome =
  | { status: 'read'; rows: number; unreadable: number }
  | { status: 'failed' }
  /** The run's time was up before a reader answered: left queued (and released) for a later run. */
  | { status: 'queued' }
  | { status: 'busy' | 'done' | 'not_found' };

export interface MatchedRow {
  dayText: string | null;
  timeText: string | null;
  nameText: string | null;
  phoneText: string | null;
  codeText: string | null;
  confidence: number;
  startAt: number | null;
  patientId: string | null;
  duplicateOfId: string | null;
  match: 'existing' | 'new' | 'duplicate' | 'unreadable';
  decision: 'accept' | 'skip' | null;
  needsCheck: boolean;
}

/** Claims a queued import: true when this run may read it. */
async function claim(db: Db, id: string, now: number): Promise<boolean> {
  const claimed = await db
    .update(imports)
    .set({ updatedAt: now })
    .where(and(eq(imports.id, id), eq(imports.status, 'queued'), lt(imports.updatedAt, now - CLAIM_MS)))
    .returning({ id: imports.id });
  return claimed.length === 1;
}

export async function processImport(
  env: Env,
  db: Db,
  importId: string,
  options: { now?: number; signal?: AbortSignal; fetch?: typeof fetch; chain?: ReaderChain } = {},
): Promise<ProcessOutcome> {
  const now = options.now ?? Date.now();
  const row = await db
    .select({ status: imports.status, fileId: imports.telegramFileId })
    .from(imports)
    .where(and(eq(imports.id, importId), isNull(imports.deletedAt)))
    .get();
  if (!row) return { status: 'not_found' };
  if (row.status !== 'queued') return { status: 'done' };
  if (!(await claim(db, importId, now))) return { status: 'busy' };

  const [procedureRows, settingsRow] = await Promise.all([
    db
      .select({ code: procedures.code, name: procedures.nameEn })
      .from(procedures)
      .where(and(isNull(procedures.deletedAt), eq(procedures.active, true)))
      .all(),
    db.select({ weeklyHours: settings.weeklyHours }).from(settings).where(eq(settings.id, SETTINGS_ID)).get(),
  ]);

  let photo: { image: ArrayBuffer; mime: string } | null = null;
  try {
    photo = await telegramPhoto(env, row.fileId, options.fetch);
  } catch (err) {
    console.error('import_photo_failed', err instanceof Error ? err.name : 'unknown');
  }
  const chain = options.chain ?? readerChain(env, now);
  if (chain.lastResort.length && (await lastResortReadsToday(db, now)) >= LAST_RESORT_READS_PER_DAY) {
    chain.lastResort = [];
  }
  const outcome = photo
    ? await readSchedule(
        chain,
        { ...photo, template: 'unknown' as TemplateCode, procedures: procedureRows, locale: 'en' },
        options.signal ? { signal: options.signal } : {},
      )
    : { ok: false as const, attempts: [] };

  if (!outcome.ok && options.signal?.aborted) {
    // PRD §12: processed later, when someone opens the Imports screen. Release the claim now.
    await db.update(imports).set({ updatedAt: 0 }).where(eq(imports.id, importId));
    return { status: 'queued' };
  }
  if (!outcome.ok) {
    // Reader ids and error kinds only (PRD §18): never content.
    console.warn('import_unread', JSON.stringify(outcome.attempts));
    await withVersion(
      db,
      db
        .update(imports)
        .set({
          status: 'failed',
          rawResult: JSON.stringify({
            promptVersion: PROMPT_VERSION,
            attempts: outcome.attempts,
            photo: !!photo,
          }),
          version: CURRENT_VERSION,
          updatedAt: now,
        })
        .where(eq(imports.id, importId)),
    );
    return { status: 'failed' };
  }

  const sheet = parseSheetId(outcome.result.sheetId);
  const matched = await matchRows(db, sheet, outcome.result.rows, parseWeekly(settingsRow?.weeklyHours));
  await withVersion(
    db,
    ...matched.map((m) =>
      db.insert(importRows).values({
        id: uuidv7(),
        importId,
        ...m,
        confidence: Math.round(m.confidence * 100),
        version: CURRENT_VERSION,
        updatedAt: now,
      }),
    ),
    db
      .update(imports)
      .set({
        status: 'read',
        template: sheet?.template ?? null,
        periodLabel: outcome.result.sheetId ?? null,
        provider: outcome.readerId,
        // No second copy of names and phones (privacy review M3): the rows are in import_rows.
        rawResult: JSON.stringify({
          promptVersion: PROMPT_VERSION,
          attempts: outcome.attempts,
          sheetId: outcome.result.sheetId ?? null,
          rowCount: outcome.result.rows.length,
        }),
        version: CURRENT_VERSION,
        updatedAt: now,
      })
      .where(eq(imports.id, importId)),
  );
  return {
    status: 'read',
    rows: matched.length,
    unreadable: matched.filter((m) => m.match === 'unreadable').length,
  };
}

/** Matches read rows against patients and bookings, in three queries whatever the row count. */
export async function matchRows(
  db: Db,
  sheet: SheetRef | null,
  rows: ReadRow[],
  weekly: ReturnType<typeof parseWeekly>,
): Promise<MatchedRow[]> {
  const prepared = rows.map((r) => {
    const phone = r.phone ? normalizePhone(r.phone) : null;
    return { r, e164: phone?.ok ? phone.e164 : null, start: rowStart(sheet, r, weekly) };
  });
  const phones = [...new Set(prepared.flatMap((p) => (p.e164 ? [p.e164] : [])))];
  const byPhone = new Map(
    phones.length
      ? (
          await db
            .select({ id: patients.id, phone: patients.phoneE164 })
            .from(patients)
            .where(and(inArray(patients.phoneE164, phones), isNull(patients.deletedAt)))
            .all()
        ).map((p) => [p.phone, p.id])
      : [],
  );
  // Template O has no phones: compare names with every patient (one query).
  const byName =
    sheet?.template === 'O'
      ? await db
          .select({ id: patients.id, name: patients.name })
          .from(patients)
          .where(isNull(patients.deletedAt))
          .all()
      : [];

  const patientOf = (p: (typeof prepared)[number]): { id: string; byName: boolean } | null => {
    const viaPhone = p.e164 ? byPhone.get(p.e164) : undefined;
    if (viaPhone) return { id: viaPhone, byName: false };
    if (!p.r.name || byName.length === 0) return null;
    const length = [...p.r.name].length;
    const best = byName
      // Exact shortcut (keeps CPU low on the free plan): the edit distance is at least the
      // difference in length, so names this different can never reach NAME_MATCH_MIN.
      .filter((c) => {
        const other = [...c.name].length;
        return 1 - Math.abs(other - length) / Math.max(other, length) >= NAME_MATCH_MIN - 0.05;
      })
      .map((c) => ({ id: c.id, score: nameSimilarity(p.r.name!, c.name) }))
      .filter((c) => c.score >= NAME_MATCH_MIN)
      .sort((a, b) => b.score - a.score);
    // Two patients equally close: don't pick one.
    if (best.length === 0 || (best[1] && best[1].score === best[0]!.score)) return null;
    return { id: best[0]!.id, byName: true };
  };
  const withPatient = prepared.map((p) => ({ ...p, patient: patientOf(p) }));

  const patientIds = [...new Set(withPatient.flatMap((p) => (p.patient ? [p.patient.id] : [])))];
  const period = sheet ? sheetPeriod(sheet) : null;
  const existing =
    patientIds.length && period
      ? await db
          .select({
            id: bookings.id,
            patientId: bookings.patientId,
            startAt: bookings.startAt,
            status: bookings.status,
          })
          .from(bookings)
          .where(
            and(
              inArray(bookings.patientId, patientIds),
              isNull(bookings.deletedAt),
              // The sheet's dates, with a margin for the ±30 min window.
              gt(bookings.startAt, localToUtc(period.from, 0) - DUPLICATE_WINDOW_MS),
              lt(bookings.startAt, localToUtc(addDays(period.to, 1), 0) + DUPLICATE_WINDOW_MS),
            ),
          )
          .all()
      : [];

  return withPatient.map(({ r, start, patient }) => {
    const base = {
      dayText: r.day ?? null,
      timeText: r.time ?? null,
      nameText: r.name ?? null,
      phoneText: r.phone ?? null,
      codeText: r.code ?? null,
      confidence: r.confidence,
      startAt: start?.startAt ?? null,
      patientId: patient?.id ?? null,
      duplicateOfId: null as string | null,
    };
    if (!r.name || !start) {
      return { ...base, match: 'unreadable' as const, decision: null, needsCheck: true };
    }
    const needsCheck = !!patient?.byName || start.snapped || r.confidence < LOW_CONFIDENCE;
    if (patient) {
      const duplicate = existing.find(
        (b) => b.patientId === patient.id && isActiveStatus(b.status) && isDuplicate(start.startAt, [b]),
      );
      if (duplicate) {
        return {
          ...base,
          duplicateOfId: duplicate.id,
          match: 'duplicate' as const,
          decision: 'skip' as const,
          needsCheck,
        };
      }
      return { ...base, match: 'existing' as const, decision: 'accept' as const, needsCheck };
    }
    return { ...base, match: 'new' as const, decision: 'accept' as const, needsCheck };
  });
}
