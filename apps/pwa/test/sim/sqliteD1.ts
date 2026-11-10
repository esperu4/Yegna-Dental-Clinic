/**
 * An in-process D1 for the sync simulation, on Node's built-in SQLite.
 *
 * Why: the local D1 that `getPlatformProxy` gives tests answers `prepare()` and `bind()` with
 * blocking round trips to workerd, so a simulation of thousands of requests spent most of its
 * time blocked and could not run worlds side by side. The API's own tests keep using the real
 * local D1; this stand-in is only for the simulation.
 *
 * It keeps what the sync protocol relies on: SQLite semantics (same engine as D1), foreign keys
 * on, a `batch()` that runs as one transaction (all or nothing), one statement at a time with
 * other requests able to run between statements (each call yields first, as a network call
 * would), D1's result shapes (`results`, `meta.changes`, `raw()` arrays) and its value rules
 * (booleans stored as 0/1, `undefined` refused).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

const MIGRATIONS = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'db', 'migrations');

interface D1Result<T = Record<string, unknown>> {
  success: true;
  results: T[];
  meta: { changes: number; last_row_id: number; duration: number; rows_read: number; rows_written: number };
}

/** Lets other requests run before each statement, as the wait for a real D1 answer would. */
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function toSqlite(value: unknown): SQLInputValue {
  if (value === undefined) throw new TypeError('D1_TYPE_ERROR: undefined is not a supported bind value');
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as SQLInputValue;
}

class Statement {
  constructor(
    private readonly sqlite: DatabaseSync,
    readonly sql: string,
    readonly params: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    // D1 refuses more than 100 bound values in one statement; callers must chunk.
    if (values.length > 100) throw new Error('D1_ERROR: too many SQL variables');
    return new Statement(this.sqlite, this.sql, values.map(toSqlite));
  }

  private prepared(): StatementSync {
    return this.sqlite.prepare(this.sql);
  }

  /** Runs now (inside a batch or after the yield). */
  execute<T>(): D1Result<T> {
    const stmt = this.prepared();
    const before = this.totalChanges();
    const results = stmt.all(...this.params) as T[];
    const changed = this.totalChanges() !== before;
    const meta = this.sqlite.prepare('SELECT changes() AS c, last_insert_rowid() AS r').get() as {
      c: number;
      r: number;
    };
    const changes = changed ? meta.c : 0;
    return {
      success: true,
      results,
      meta: { changes, last_row_id: meta.r, duration: 0, rows_read: results.length, rows_written: changes },
    };
  }

  private totalChanges(): number {
    return (this.sqlite.prepare('SELECT total_changes() AS t').get() as { t: number }).t;
  }

  async all<T>(): Promise<D1Result<T>> {
    await yieldTurn();
    return this.execute<T>();
  }

  async run(): Promise<D1Result> {
    await yieldTurn();
    return this.execute();
  }

  async first<T>(column?: string): Promise<T | null> {
    await yieldTurn();
    const row = this.execute<Record<string, unknown>>().results[0];
    if (!row) return null;
    return (column === undefined ? row : row[column]) as T;
  }

  async raw<T extends unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    await yieldTurn();
    const stmt = this.prepared();
    stmt.setReturnArrays(true);
    const rows = stmt.all(...this.params) as unknown as T[];
    if (!options?.columnNames) return rows;
    return [stmt.columns().map((c) => c.name) as T, ...rows];
  }
}

export class SqliteD1 {
  private readonly sqlite = new DatabaseSync(':memory:');

  constructor() {
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    const statements = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .flatMap((f) => readFileSync(join(MIGRATIONS, f), 'utf8').split('--> statement-breakpoint'))
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) this.sqlite.exec(statement);
  }

  prepare(sql: string): Statement {
    return new Statement(this.sqlite, sql);
  }

  /** One transaction: every statement or none (as D1's batch). */
  async batch<T>(statements: Statement[]): Promise<D1Result<T>[]> {
    await yieldTurn();
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((s) => s.execute<T>());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    await yieldTurn();
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }

  close(): void {
    this.sqlite.close();
  }
}
