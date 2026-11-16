/**
 * Turns a backup into SQL that replaces a database's contents (PRD §17 restore), after checking it
 * against the schema the target runs: every table in the backup must exist there, with no column
 * the target does not know. Pure, so it is tested against a real local D1 and used by
 * `scripts/restore.ts`.
 */
import type { BackupData } from './format.ts';

export interface TargetSchema {
  /** Table name → its columns, as in the target database (`PRAGMA table_info`). */
  [table: string]: string[];
}

/** Children before parents, so deletes respect foreign keys (inserts go the other way). */
const DELETE_FIRST = [
  'audit_log',
  'import_rows',
  'patient_requests',
  'notification_log',
  'bookings',
  'imports',
  'devices',
  'telegram_link_codes',
  'sync_ops',
];
const INSERT_FIRST = [
  'sync_seq',
  'users',
  'settings',
  'procedures',
  'patients',
  'devices',
  'bookings',
  'imports',
  'import_rows',
  'patient_requests',
];

export interface Validation {
  ok: boolean;
  problems: string[];
  counts: Record<string, number>;
}

export function validateBackup(data: BackupData, schema: TargetSchema): Validation {
  const problems: string[] = [];
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(data.tables)) {
    counts[table] = rows.length;
    const columns = schema[table];
    if (!columns) {
      problems.push(`table ${table} is not in the target database`);
      continue;
    }
    const known = new Set(columns);
    const unknown = new Set<string>();
    for (const row of rows) for (const c of Object.keys(row)) if (!known.has(c)) unknown.add(c);
    if (unknown.size) problems.push(`table ${table}: unknown columns ${[...unknown].join(', ')}`);
  }
  for (const table of Object.keys(schema)) {
    if (!(table in data.tables)) problems.push(`table ${table} is missing from the backup`);
  }
  return { ok: problems.length === 0, problems, counts };
}

const order = (tables: string[], first: string[]) =>
  [...tables].sort((a, b) => {
    const ia = first.indexOf(a);
    const ib = first.indexOf(b);
    return (ia === -1 ? first.length : ia) - (ib === -1 ? first.length : ib) || a.localeCompare(b);
  });

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in backup');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replaceAll("'", "''")}'`;
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`bad identifier ${name}`);
  return `"${name}"`;
};

/**
 * Statements that empty every backed-up table and load the backup's rows (one INSERT per row).
 * Run them in one transaction (`wrangler d1 execute --file` does).
 */
export function restoreStatements(data: BackupData): string[] {
  const tables = Object.keys(data.tables);
  const statements = ['PRAGMA defer_foreign_keys = ON'];
  // Reverse insert order empties children first; tables not listed come last.
  const deletes = [...new Set([...order(tables, DELETE_FIRST)])];
  for (const t of deletes) statements.push(`DELETE FROM ${ident(t)}`);
  for (const t of order(tables, INSERT_FIRST)) {
    for (const row of data.tables[t]!) {
      const columns = Object.keys(row);
      if (columns.length === 0) continue;
      statements.push(
        `INSERT INTO ${ident(t)} (${columns.map(ident).join(', ')}) VALUES (${columns.map((c) => literal(row[c])).join(', ')})`,
      );
    }
  }
  return statements;
}

/** What the target database knew before it was replaced, to keep after the restore. */
export interface Keep {
  /** Devices revoked in the target (a lost phone must stay locked out). */
  revokedDevices: { id: string; revokedAt: number }[];
  /** Patients deleted in the target: erased again (ADR 0007). */
  erasedPatients: string[];
}

const list = (ids: string[]) => ids.map(literal).join(', ');

/**
 * Runs after the inserts, in the same file (privacy review M6):
 * - revocations and erasures made after the backup are applied again, so a restore never gives a
 *   lost phone its access back or brings an erased patient's details back;
 * - unless `keepDevices`, every phone is signed out. Phones then wipe their working copy and enrol
 *   again, so none keeps rows newer than the restored ones (the sync cursors would otherwise skip them).
 */
export function afterRestoreStatements(keep: Keep, now: number, keepDevices = false): string[] {
  const out: string[] = [];
  for (const d of keep.revokedDevices) {
    out.push(`UPDATE "devices" SET "revoked_at" = ${literal(d.revokedAt)} WHERE "id" = ${literal(d.id)}`);
  }
  if (!keepDevices) out.push(`UPDATE "devices" SET "revoked_at" = ${now} WHERE "revoked_at" IS NULL`);
  for (let i = 0; i < keep.erasedPatients.length; i += 50) {
    const ids = list(keep.erasedPatients.slice(i, i + 50));
    out.push(
      `UPDATE "patients" SET "name" = '', "phone_e164" = '', "note" = NULL, "telegram_chat_id" = NULL, "telegram_linked_at" = NULL, "telegram_locale" = NULL, "deleted_at" = coalesce("deleted_at", ${now}) WHERE "id" IN (${ids})`,
      `UPDATE "bookings" SET "note" = NULL, "cancel_reason" = NULL WHERE "patient_id" IN (${ids})`,
      `UPDATE "audit_log" SET "diff" = NULL WHERE "entity" = 'patients' AND "entity_id" IN (${ids})`,
      `UPDATE "audit_log" SET "diff" = json_remove("diff", '$.note', '$.cancelReason', '$.fields.note', '$.fields.cancelReason') WHERE "entity" = 'bookings' AND "diff" IS NOT NULL AND ("entity_id" IN (SELECT "id" FROM "bookings" WHERE "patient_id" IN (${ids})) OR json_extract("diff", '$.fields.patientId') IN (${ids}))`,
      `DELETE FROM "notification_log" WHERE "kind" IN ('patient_confirm', 'patient_reminder', 'patient_cancel') AND substr("booking_id", 1, 36) IN (SELECT "id" FROM "bookings" WHERE "patient_id" IN (${ids}))`,
      `UPDATE "patient_requests" SET "status" = 'handled' WHERE "status" = 'open' AND "patient_id" IN (${ids})`,
    );
  }
  return out;
}
