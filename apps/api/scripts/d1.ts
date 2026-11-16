/** `wrangler d1 execute` helpers for the backup and restore scripts (local, staging, production). */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const API_DIR = join(import.meta.dirname, '..');
export const TARGETS = ['local', 'staging', 'production'] as const;
export type Target = (typeof TARGETS)[number];

/** wrangler's own entry, run with this Node (no shell, so SQL arguments stay whole on Windows). */
const WRANGLER = join(
  dirname(createRequire(join(API_DIR, 'package.json')).resolve('wrangler/package.json')),
  'bin',
  'wrangler.js',
);

export function wrangler(target: Target, args: string[], command: 'd1' | 'time-travel' = 'd1'): string {
  const where = target === 'local' ? ['--local'] : ['--remote', '--env', target];
  const base =
    command === 'd1'
      ? ['d1', 'execute', 'DB', ...where]
      : ['d1', 'time-travel', 'info', 'DB', '--env', target];
  try {
    return execFileSync(process.execPath, [WRANGLER, ...base, ...args], {
      cwd: API_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (err) {
    // The error carries wrangler's output, which can hold rows: report the exit code only.
    const status = (err as { status?: number }).status ?? 'unknown';
    // No `cause` on purpose: the caught error holds wrangler's output, which may contain rows.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`wrangler failed (exit ${status}); its messages are above`);
  }
}

/** The database's current Time Travel bookmark (remote only): the point to undo a restore to. */
export function timeTravelBookmark(target: Target): string {
  const out = wrangler(target, ['--json'], 'time-travel');
  return (JSON.parse(out) as { bookmark: string }).bookmark;
}

export function query<T>(target: Target, sql: string): T[] {
  const out = JSON.parse(wrangler(target, ['--json', '--command', sql])) as { results: T[] }[];
  return out.flatMap((r) => r.results);
}

export function schemaOf(target: Target): Record<string, string[]> {
  const rows = query<{ t: string; c: string }>(
    target,
    "SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%' AND m.name NOT LIKE 'd1_%'",
  );
  const schema: Record<string, string[]> = {};
  for (const r of rows) (schema[r.t] ??= []).push(r.c);
  return schema;
}

export function counts(target: Target, tables: string[]): Record<string, number> {
  // One statement per table (D1 limits compound SELECTs); answers come back in order.
  const sql = tables.map((t) => `SELECT count(*) AS n FROM "${t}"`).join('; ');
  const out = JSON.parse(wrangler(target, ['--json', '--command', sql])) as { results: { n: number }[] }[];
  return Object.fromEntries(tables.map((t, i) => [t, out[i]?.results[0]?.n ?? -1]));
}
