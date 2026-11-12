/**
 * Daily limits on imports (privacy review 2026-11-11, M4): a retry loop or a misused phone must
 * not use up the private readers' free allowance and push every photo to the last-resort reader.
 */
import { and, count, eq, gte, like } from 'drizzle-orm';
import { imports } from '@yegna/db';
import { localDateOf, localToUtc } from '@yegna/time';
import type { Db } from '../lib/db.ts';

/** New imports per person per clinic day (a busy day is a few sheets). */
export const IMPORTS_PER_USER_PER_DAY = 30;
/** Photos read by the last-resort reader (Gemini free) per clinic day, for the whole clinic. */
export const LAST_RESORT_READS_PER_DAY = 20;

const startOfDay = (now: number) => localToUtc(localDateOf(now), 0);

export async function importsToday(db: Db, userId: string, now: number): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(imports)
    .where(and(eq(imports.uploadedBy, userId), gte(imports.createdAt, startOfDay(now))))
    .get();
  return row?.n ?? 0;
}

export async function lastResortReadsToday(db: Db, now: number): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(imports)
    .where(and(like(imports.provider, 'gemini:%'), gte(imports.createdAt, startOfDay(now))))
    .get();
  return row?.n ?? 0;
}
