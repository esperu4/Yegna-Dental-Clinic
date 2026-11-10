/** Re-render on working-copy changes: a Preact hook over Dexie's `liveQuery`. */
import { liveQuery } from 'dexie';
import { useEffect, useState } from 'preact/hooks';

/**
 * The result of `query`, kept current as the Dexie tables it reads change (local writes and
 * synced rows alike). `undefined` until the first result. `deps` re-subscribe like `useEffect`.
 */
export function useLive<T>(query: () => Promise<T>, deps: readonly unknown[]): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    const subscription = liveQuery(query).subscribe({
      next: setValue,
      error: () => setValue(undefined),
    });
    return () => subscription.unsubscribe();
  }, deps);
  return value;
}

/** Working-copy rows that are not tombstones (deleted rows keep only their key; never show them). */
export function live<T extends { deletedAt?: number | null }>(rows: T[]): T[] {
  return rows.filter((r) => r.deletedAt == null);
}
