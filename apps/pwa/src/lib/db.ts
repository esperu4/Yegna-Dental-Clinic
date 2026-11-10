/**
 * On-device storage (Dexie / IndexedDB, PRD §7.1–7.2):
 * - `meta`: session, PIN verifier, sync cursor and other small values;
 * - one table per synced entity: the working copy the UI reads from;
 * - `outbox`: ops waiting for the server, in the order they were made;
 * - `notices`: refused ops and clashes the user has not dismissed yet.
 */
import Dexie, { type Table } from 'dexie';
import type { PullEntity, RowOf, SyncOp, SyncRejectReason, WriteEntity } from '@yegna/shared/client';

export interface MetaRow {
  key: string;
  value: unknown;
}

/**
 * A working-copy row. `provisional` = changed on this device and not yet accepted by the server.
 * A row with `deletedAt` set is a tombstone holding only its key and meta: screens must skip it.
 */
export type LocalRow<E extends PullEntity> = RowOf[E] & { provisional?: boolean };

/**
 * Something the user must see about an op: the server refused it (the change was rolled back;
 * `fields` keeps what was entered so it can be re-done) or a booking clashed (PRD §7.5).
 * Kept until the user dismisses it.
 */
export interface Notice {
  opId: string;
  kind: 'rejected' | 'clash';
  entity: WriteEntity;
  entityId: string;
  reason?: SyncRejectReason;
  winner?: string;
  fields: Record<string, unknown>;
  at: number;
}

/** An outbox entry. `seq` keeps creation order even for ops made in the same millisecond. */
export interface OutboxEntry {
  seq?: number;
  op: SyncOp;
}

export class YegnaDb extends Dexie {
  meta!: Table<MetaRow, string>;
  outbox!: Table<OutboxEntry, number>;
  notices!: Table<Notice, string>;
  patients!: Table<LocalRow<'patients'>, string>;
  bookings!: Table<LocalRow<'bookings'>, string>;
  procedures!: Table<LocalRow<'procedures'>, string>;
  dayRules!: Table<LocalRow<'dayRules'>, string>;
  blocks!: Table<LocalRow<'blocks'>, string>;
  holidays!: Table<LocalRow<'holidays'>, string>;
  settings!: Table<LocalRow<'settings'>, string>;
  users!: Table<LocalRow<'users'>, string>;

  constructor(name = 'yegna') {
    super(name);
    this.version(1).stores({ meta: 'key' });
    this.version(2).stores({
      outbox: '++seq',
      notices: 'opId, at',
      // Phone and name back the booking sheet's patient search (PRD §8 item 5).
      patients: 'id, phoneE164, name',
      // Day and week views read by start time; patient history by patient.
      bookings: 'id, startAt, patientId',
      procedures: 'id',
      dayRules: 'date',
      blocks: 'id, startAt',
      holidays: 'id, date',
      settings: 'id',
      users: 'id',
    });
  }

  entity<E extends PullEntity>(entity: E): Table<LocalRow<E>, string> {
    return this.table(entity) as Table<LocalRow<E>, string>;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.meta.get(key))?.value as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.meta.put({ key, value });
  }
}

export const db = new YegnaDb();
