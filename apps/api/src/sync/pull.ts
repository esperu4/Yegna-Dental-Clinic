/**
 * The pull half of `/sync` (PRD §7.4): every row with `version > cursor`, oldest first, in pages.
 *
 * Every column sent is listed here explicitly, so a server-only column added later (a chat id,
 * a PIN hash) is never synced by accident (PRD §18).
 */
import { type SQL, and, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { blocks, bookings, dayRules, holidays, patients, procedures, settings, users } from '@yegna/db';
import {
  PULL_PAGE_SIZE,
  type PullEntity,
  type RowOf,
  type SyncChanges,
  type Tombstone,
  bookingWindowStart,
  rowKey,
} from '@yegna/shared';
import { DEFAULT_WEEKLY_HOURS, type WeeklyDefaults } from '@yegna/time';
import type { Db } from '../lib/db.ts';
import { KEY_COLUMNS, TABLES } from './tables.ts';

const meta = <
  T extends {
    version: SQLiteColumn;
    updatedAt: SQLiteColumn;
    updatedBy: SQLiteColumn;
    deletedAt: SQLiteColumn;
  },
>(
  t: T,
) => ({ version: t.version, updatedAt: t.updatedAt, updatedBy: t.updatedBy, deletedAt: t.deletedAt });

/** Wire columns per entity. */
const COLUMNS = {
  patients: {
    id: patients.id,
    name: patients.name,
    phoneE164: patients.phoneE164,
    note: patients.note,
    telegramLinked: sql<boolean>`${patients.telegramChatId} IS NOT NULL`.mapWith(Boolean),
    ...meta(patients),
  },
  bookings: {
    id: bookings.id,
    patientId: bookings.patientId,
    procedureId: bookings.procedureId,
    startAt: bookings.startAt,
    durationMin: bookings.durationMin,
    status: bookings.status,
    approvedBy: bookings.approvedBy,
    approvedAt: bookings.approvedAt,
    patientConfirmedAt: bookings.patientConfirmedAt,
    source: bookings.source,
    cancelReason: bookings.cancelReason,
    clashWithId: bookings.clashWithId,
    note: bookings.note,
    createdBy: bookings.createdBy,
    ...meta(bookings),
  },
  procedures: {
    id: procedures.id,
    nameAm: procedures.nameAm,
    nameEn: procedures.nameEn,
    code: procedures.code,
    durationMin: procedures.durationMin,
    color: procedures.color,
    active: procedures.active,
    sort: procedures.sort,
    ...meta(procedures),
  },
  dayRules: {
    date: dayRules.date,
    openAt: dayRules.openAt,
    closeAt: dayRules.closeAt,
    lunchStart: dayRules.lunchStart,
    lunchEnd: dayRules.lunchEnd,
    closed: dayRules.closed,
    note: dayRules.note,
    ...meta(dayRules),
  },
  blocks: {
    id: blocks.id,
    startAt: blocks.startAt,
    endAt: blocks.endAt,
    reason: blocks.reason,
    ...meta(blocks),
  },
  holidays: {
    id: holidays.id,
    date: holidays.date,
    nameAm: holidays.nameAm,
    nameEn: holidays.nameEn,
    closed: holidays.closed,
    ...meta(holidays),
  },
  settings: {
    id: settings.id,
    weeklyHours: settings.weeklyHours,
    unspecifiedDurationMin: settings.unspecifiedDurationMin,
    patientReminderAt: settings.patientReminderAt,
    doctorSummaryAt: settings.doctorSummaryAt,
    defaultTemplate: settings.defaultTemplate,
    ...meta(settings),
  },
  // Names and roles only (PRD §7.1): never PIN hashes, chat ids or preferences.
  users: { id: users.id, name: users.name, role: users.role, disabledAt: users.disabledAt, ...meta(users) },
} as const;

const META_FIELDS = ['version', 'updatedAt', 'updatedBy', 'deletedAt'] as const;

/**
 * Rows as stored → rows on the wire. A deleted row goes out as its key and meta only: a
 * tombstone tells devices to drop the row and never carries a deleted patient's name or phone
 * (PRD §18). `settings.weeklyHours` is decoded from JSON.
 */
function toWire<E extends PullEntity>(entity: E, row: Record<string, unknown>): RowOf[E] | Tombstone {
  if (row.deletedAt !== null && row.deletedAt !== undefined) {
    const keyField = entity === 'dayRules' ? 'date' : 'id';
    return Object.fromEntries([keyField, ...META_FIELDS].map((f) => [f, row[f]])) as unknown as Tombstone;
  }
  if (entity === 'settings') {
    return { ...row, weeklyHours: parseWeeklyHours(row.weeklyHours as string) } as unknown as RowOf[E];
  }
  return row as unknown as RowOf[E];
}

function parseWeeklyHours(json: string): WeeklyDefaults {
  try {
    return JSON.parse(json) as WeeklyDefaults;
  } catch {
    return DEFAULT_WEEKLY_HOURS;
  }
}

export interface PullResult {
  changes: SyncChanges;
  newCursor: number;
  more: boolean;
}

/**
 * Rows with `version > cursor`, about `pageSize` of them, lowest versions first.
 * All tables are read in one batch, i.e. one consistent snapshot: reading them one by one could
 * see a later write in one table but miss an earlier one in another and skip it for good.
 * During the first fill (`initial`), bookings older than the window are left out; history loads
 * on demand (PRD §7.1). Later pulls include every changed booking, so no device keeps a stale row.
 */
export async function pull(
  db: Db,
  cursor: number,
  now: number,
  { initial = false, pageSize = PULL_PAGE_SIZE }: { initial?: boolean; pageSize?: number } = {},
): Promise<PullResult> {
  const entities = Object.keys(COLUMNS) as PullEntity[];
  const conditionsFor = (entity: PullEntity, versionCondition: SQL): SQL[] => {
    const conditions: SQL[] = [versionCondition];
    // A pull from cursor 0 is always a first fill, whatever the device says.
    if (entity === 'bookings' && (initial || cursor === 0)) {
      conditions.push(gte(bookings.startAt, bookingWindowStart(now)));
    }
    return conditions;
  };
  const queries = entities.map((entity) => {
    const table = TABLES[entity];
    const conditions = conditionsFor(entity, gt(table.version, cursor));
    return db
      .select(COLUMNS[entity])
      .from(table)
      .where(and(...conditions))
      .orderBy(table.version)
      .limit(pageSize + 1);
  });
  const results = (await db.batch(queries as unknown as [(typeof queries)[number]])) as unknown as Record<
    string,
    unknown
  >[][];

  const merged = results
    .flatMap((rows, i) => rows.map((row) => ({ entity: entities[i]!, row })))
    .sort((a, b) => (a.row.version as number) - (b.row.version as number));
  // Never end a page inside a version: the cursor moves past it, and the rest would be skipped.
  let end = Math.min(pageSize, merged.length);
  while (end > 0 && end < merged.length && merged[end]!.row.version === merged[end - 1]!.row.version) end++;
  const page = merged.slice(0, end);

  // One batch can give many rows the same version (erasing a patient touches all their bookings).
  // If a table's fetch was cut off inside the last version on the page, read the rest of that
  // version too, so the cursor never moves past rows not sent.
  const last = page.at(-1)?.row.version as number | undefined;
  if (last !== undefined) {
    const cut = entities.filter(
      (_, i) => results[i]!.length > pageSize && results[i]!.at(-1)!.version === last,
    );
    if (cut.length) {
      const rest = (await db.batch(
        cut.map((entity) =>
          db
            .select(COLUMNS[entity])
            .from(TABLES[entity])
            .where(and(...conditionsFor(entity, eq(TABLES[entity].version, last)))),
        ) as never,
      )) as unknown as Record<string, unknown>[][];
      const seen = new Set(page.map((p) => `${p.entity}:${rowKey(p.entity, p.row as never)}`));
      rest.forEach((rows, i) => {
        for (const row of rows) {
          const entity = cut[i]!;
          if (!seen.has(`${entity}:${rowKey(entity, row as never)}`)) page.push({ entity, row });
        }
      });
    }
  }

  const changes: SyncChanges = {};
  for (const { entity, row } of page) {
    ((changes[entity] ??= []) as unknown[]).push(toWire(entity, row));
  }
  return {
    changes,
    newCursor: page.length ? (page[page.length - 1]!.row.version as number) : cursor,
    // More if rows were left on this read, or a table was cut off (it may hold later versions).
    more: merged.length > end || results.some((rows) => rows.length > pageSize),
  };
}

/** D1 allows 100 bound parameters per statement. */
const MAX_IDS_PER_QUERY = 90;

/**
 * Current rows for the given keys, whatever their version, in one batch. Sent back for refused
 * ops so the device can replace its optimistic copy with the server's (PRD §9).
 */
export async function currentRows(db: Db, keys: { entity: PullEntity; key: string }[]): Promise<SyncChanges> {
  const byEntity = new Map<PullEntity, string[]>();
  for (const { entity, key } of keys) byEntity.set(entity, [...(byEntity.get(entity) ?? []), key]);
  const lookups: { entity: PullEntity; ids: string[] }[] = [];
  for (const [entity, ids] of byEntity) {
    for (let i = 0; i < ids.length; i += MAX_IDS_PER_QUERY)
      lookups.push({ entity, ids: ids.slice(i, i + MAX_IDS_PER_QUERY) });
  }
  const results = (await db.batch(
    lookups.map(({ entity, ids }) =>
      db.select(COLUMNS[entity]).from(TABLES[entity]).where(inArray(KEY_COLUMNS[entity], ids)),
    ) as never,
  )) as unknown as Record<string, unknown>[][];
  const changes: SyncChanges = {};
  results.forEach((rows, i) => {
    const { entity } = lookups[i]!;
    for (const r of rows) ((changes[entity] ??= []) as unknown[]).push(toWire(entity, r));
  });
  return changes;
}

/** Merges `extra` into `changes`, keeping one row per key (the higher version wins). */
export function mergeChanges(changes: SyncChanges, extra: SyncChanges): SyncChanges {
  const out: SyncChanges = { ...changes };
  for (const entity of Object.keys(extra) as PullEntity[]) {
    const key = entity === 'dayRules' ? 'date' : 'id';
    const rows = new Map<string, Record<string, unknown>>();
    for (const r of [...(out[entity] ?? []), ...(extra[entity] ?? [])] as unknown as Record<
      string,
      unknown
    >[]) {
      const k = r[key] as string;
      const prev = rows.get(k);
      if (!prev || (r.version as number) > (prev.version as number)) rows.set(k, r);
    }
    out[entity] = [...rows.values()] as never;
  }
  return out;
}
