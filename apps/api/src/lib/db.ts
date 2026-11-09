import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import { schema } from '@yegna/db';

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
export type Db = ReturnType<typeof getDb>;

/**
 * Next value of the single `sync_seq` counter (PRD §7.4). Creates the row on first use,
 * so a fresh database needs no seed (docs/adr/0002-storage-conventions.md).
 */
export async function nextVersion(db: Db): Promise<number> {
  const row = await db.get<{ value: number }>(
    sql`INSERT INTO sync_seq (id, value) VALUES (1, 1)
        ON CONFLICT(id) DO UPDATE SET value = value + 1 RETURNING value`,
  );
  return row.value;
}

/** True for a UNIQUE / PRIMARY KEY violation from D1 (possibly wrapped by Drizzle). */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (/UNIQUE constraint failed|PRIMARY KEY/i.test(e.message)) return true;
  }
  return false;
}
