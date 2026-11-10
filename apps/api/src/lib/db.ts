import { SQL, is, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { schema } from '@yegna/db';

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
export type Db = ReturnType<typeof getDb>;

/**
 * Row versions (PRD §7.4, docs/adr/0006-sync-protocol.md). A version must be taken **inside the
 * same batch** as the write that uses it: `bumpVersion(db)` first, then `CURRENT_VERSION` in the
 * writes. A batch is one transaction and D1 runs them one at a time, so versions become visible
 * in increasing order and a device that has pulled up to version N can never later miss a row
 * with a version ≤ N. (Taking the number in an earlier request lets a smaller version commit
 * after a larger one has been pulled, and that row is then never synced.)
 *
 * The `sync_seq` row is created on first use, so a fresh database needs no seed.
 */
const BUMP_VERSION = sql`INSERT INTO sync_seq (id, value) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET value = value + 1`;

export function bumpVersion(db: Db) {
  return db.run(BUMP_VERSION);
}

/** The version taken by the preceding `bumpVersion` in the same batch. */
export const CURRENT_VERSION = sql<number>`(SELECT value FROM sync_seq WHERE id = 1)`;

/** A Drizzle query builder or a raw `sql` fragment. */
export type Statement = SQL | { toSQL(): { sql: string; params: unknown[] } };

const dialect = new SQLiteSyncDialect();

function toD1(db: Db, statement: Statement): D1PreparedStatement {
  const query = is(statement, SQL) ? dialect.sqlToQuery(statement) : statement.toSQL();
  return db.$client.prepare(query.sql).bind(...query.params);
}

/**
 * Runs statements as one D1 batch (one transaction: all or nothing). Use this instead of
 * `db.batch` when a raw `sql` statement has bound parameters: Drizzle 0.45's `db.batch` crashes
 * on those. Results are raw D1 results (snake_case columns).
 */
export async function rawBatch(db: Db, statements: Statement[]): Promise<D1Result[]> {
  return db.$client.batch(statements.map((s) => toD1(db, s)));
}

/** Runs `statements` in one batch after taking a new version; returns their results in order. */
export async function withVersion(db: Db, ...statements: Statement[]): Promise<D1Result[]> {
  const [, ...results] = await rawBatch(db, [BUMP_VERSION, ...statements]);
  return results;
}

/** True for a UNIQUE / PRIMARY KEY violation from D1 (possibly wrapped by Drizzle). */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (/UNIQUE constraint failed|PRIMARY KEY/i.test(e.message)) return true;
  }
  return false;
}
