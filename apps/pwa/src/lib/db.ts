/**
 * On-device storage (Dexie / IndexedDB). M1 keeps the session here; the working copy and the
 * outbox (PRD §7.1–7.2) are added as further tables in later versions.
 */
import Dexie, { type Table } from 'dexie';

export interface MetaRow {
  key: string;
  value: unknown;
}

export class YegnaDb extends Dexie {
  meta!: Table<MetaRow, string>;

  constructor(name = 'yegna') {
    super(name);
    this.version(1).stores({ meta: 'key' });
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.meta.get(key))?.value as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.meta.put({ key, value });
  }
}

export const db = new YegnaDb();
