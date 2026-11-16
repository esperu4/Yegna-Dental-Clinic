/**
 * Backups (PRD §16, §17, ADR 0012):
 * - from 02:00, once a day: every table, encrypted, uploaded to the clinic's Google Drive; expired
 *   backups deleted (last 30 plus every 1st of the month kept). A failure is retried each hour
 *   that day, and the Doctor is told once.
 * - Sunday from 21:00, once: the weekly spreadsheet (CSV) to the Doctor on Telegram.
 * Logs carry the step and an HTTP status at most, never data.
 */
import { and, asc, eq, gte, isNull, lt } from 'drizzle-orm';
import { bookings, patients, procedures } from '@yegna/db';
import {
  addDays,
  formatEthiopianDate,
  formatEtTime,
  formatLocalTime,
  parseIsoDate,
  toEthiopian,
  utcToLocal,
  localToUtc,
  weekdayOf,
} from '@yegna/time';
import {
  type BackupData,
  FORMAT_VERSION,
  backupName,
  encodeBackup,
  expiredBackups,
  importKey,
} from '../backup/format.ts';
import { type DriveClient, DriveError, driveClient } from '../backup/drive.ts';
import type { Db } from '../lib/db.ts';
import { deliverOnce, runOnce } from '../notify/deliver.ts';
import { backupFailed, weeklyCsvCaption } from '../notify/messages.ts';
import type { Recipient } from '../notify/messages.ts';
import type { JobContext } from './team.ts';

/** Tables D1 or wrangler manage themselves: not ours to back up or restore. */
export const isAppTable = (name: string) => !/^(sqlite_|_cf_|d1_)/.test(name);

/** Every app table's rows, as D1 returns them (snake_case). One query per table. */
export async function exportTables(d1: D1Database): Promise<BackupData['tables']> {
  const { results } = await d1
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>();
  const tables: BackupData['tables'] = {};
  for (const { name } of results.filter((t) => isAppTable(t.name))) {
    tables[name] = (await d1.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>()).results;
  }
  return tables;
}

export interface BackupEnv {
  ENVIRONMENT: string;
  BACKUP_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
}

export function backupConfigured(env: BackupEnv): boolean {
  return Boolean(
    env.BACKUP_KEY && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN,
  );
}

export interface BackupDeps {
  d1: D1Database;
  env: BackupEnv;
  /** Tests pass a fake Drive. */
  drive?: DriveClient;
}

/** From 02:00 local, once per day; `notification_log` kind `backup`, key `day:<date>`. */
export async function nightlyBackup(ctx: JobContext, team: Recipient[], deps: BackupDeps) {
  if (ctx.local.minutes < 2 * 60 || !backupConfigured(deps.env)) return;
  if (ctx.meter.remaining() < 30) return; // one query per table and the bookkeeping
  const day = `day:${ctx.local.date}`;
  let drive: DriveClient | undefined;
  const result = await runOnce(
    ctx.db,
    { kind: 'backup', key: day, chatId: 'drive' },
    async () => {
      const key = await importKey(deps.env.BACKUP_KEY!);
      const data: BackupData = {
        format: FORMAT_VERSION,
        createdAt: ctx.now,
        tables: await exportTables(deps.d1),
      };
      const file = await encodeBackup(data, key);
      drive =
        deps.drive ??
        driveClient(
          {
            clientId: deps.env.GOOGLE_CLIENT_ID!,
            clientSecret: deps.env.GOOGLE_CLIENT_SECRET!,
            refreshToken: deps.env.GOOGLE_REFRESH_TOKEN!,
          },
          deps.env.ENVIRONMENT,
        );
      await drive.upload(backupName(deps.env.ENVIRONMENT, ctx.local.date), ctx.local.date, file);
    },
    ctx.now,
  );
  if (result === 'sent' && drive) {
    // Retention after a good upload; a failure here only logs (the backup itself is safe) and the
    // next night tries again.
    try {
      for (const id of expiredBackups(await drive.list(), 30, undefined, ctx.local.date))
        await drive.remove(id);
    } catch (err) {
      console.error(
        'backup_retention_failed',
        err instanceof DriveError ? err.message : err instanceof Error ? err.name : 'unknown',
      );
    }
  }
  if (result !== 'failed' && result !== 'dropped') return;
  for (const r of team.filter((m) => m.role === 'doctor')) {
    await deliverOnce(
      ctx.db,
      ctx.notifier,
      { kind: 'backup_failed', key: day, chatId: r.chatId },
      () => backupFailed(r),
      ctx.now,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The weekly CSV (PRD §16, §17.3)

const WEEKS = 8;

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let s = String(value);
  // A cell starting with = + - @ is a formula in spreadsheet apps: keep it text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** `0911223344`: how staff write phones, and no leading `+` for spreadsheets to quote. */
const national = (e164: string) => (e164.startsWith('+251') ? `0${e164.slice(4)}` : e164);

const csv = (rows: (string | number | null)[][]) =>
  // A BOM, so spreadsheet apps read Amharic (UTF-8) correctly.
  new TextEncoder().encode(`\uFEFF${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`);

/** Patients, and bookings from 8 weeks back to 8 weeks ahead, as two CSV files. */
export async function weeklyCsvFiles(db: Db, now: number) {
  const today = utcToLocal(now).date;
  const from = localToUtc(addDays(today, -7 * WEEKS), 0);
  const to = localToUtc(addDays(today, 7 * WEEKS + 1), 0);
  const people = await db
    .select({
      name: patients.name,
      phone: patients.phoneE164,
      note: patients.note,
      chat: patients.telegramChatId,
    })
    .from(patients)
    .where(isNull(patients.deletedAt))
    .orderBy(asc(patients.name))
    .all();
  const rows = await db
    .select({
      startAt: bookings.startAt,
      durationMin: bookings.durationMin,
      status: bookings.status,
      name: patients.name,
      phone: patients.phoneE164,
      procedure: procedures.code,
      note: bookings.note,
    })
    .from(bookings)
    .innerJoin(patients, eq(patients.id, bookings.patientId))
    .leftJoin(procedures, eq(procedures.id, bookings.procedureId))
    .where(and(gte(bookings.startAt, from), lt(bookings.startAt, to), isNull(bookings.deletedAt)))
    .orderBy(asc(bookings.startAt))
    .all();
  return {
    patients: csv([
      ['Name', 'Phone', 'Telegram', 'Note'],
      ...people.map((p) => [p.name, national(p.phone), p.chat ? 'yes' : 'no', p.note]),
    ]),
    bookings: csv([
      [
        'Ethiopian date',
        'ET time',
        'Date',
        'Time',
        'Minutes',
        'Status',
        'Patient',
        'Phone',
        'Procedure',
        'Note',
      ],
      ...rows.map((b) => {
        const { date, minutes } = utcToLocal(b.startAt);
        return [
          formatEthiopianDate(toEthiopian(parseIsoDate(date)), 'en'),
          formatEtTime(minutes, 'en'),
          date,
          formatLocalTime(minutes),
          b.durationMin,
          b.status,
          b.name || '…',
          national(b.phone),
          b.procedure,
          b.note,
        ];
      }),
    ]),
  };
}

/** Sunday from 21:00: the CSV files to each Doctor, once per week. */
export async function weeklyCsv(ctx: JobContext, team: Recipient[]) {
  if (weekdayOf(ctx.local.date) !== 0 || ctx.local.minutes < 21 * 60) return;
  const doctors = team.filter((r) => r.role === 'doctor');
  const send = ctx.notifier.sendDocument?.bind(ctx.notifier);
  if (doctors.length === 0 || !send || ctx.meter.remaining() < 10) return;
  let files: Awaited<ReturnType<typeof weeklyCsvFiles>> | undefined;
  for (const r of doctors) {
    for (const which of ['patients', 'bookings'] as const) {
      // One record per file, so a failed second file does not send the first again.
      await runOnce(
        ctx.db,
        { kind: `weekly_csv_${which}`, key: `week:${ctx.local.date}`, chatId: r.chatId },
        async () => {
          files ??= await weeklyCsvFiles(ctx.db, ctx.now);
          await send(r.chatId, {
            filename: `${which}-${ctx.local.date}.csv`,
            content: files[which],
            caption: weeklyCsvCaption(r, ctx.local.date),
          });
        },
        ctx.now,
      );
    }
  }
}
