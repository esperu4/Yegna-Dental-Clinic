import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSeedSql } from '../src/seed.ts';

const MIGRATIONS = join(import.meta.dirname, '..', 'migrations');

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) db.exec(stmt);
    }
  }
  return db;
}

function plan(db: DatabaseSync, sql: string, ...params: (string | number)[]): string {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((r) => String(r.detail))
    .join(' | ');
}

describe('migrations + seed', () => {
  let db: DatabaseSync;
  const now = Date.UTC(2026, 10, 9, 6, 0); // Monday 09:00 Addis Ababa

  beforeAll(() => {
    db = migratedDb();
    db.exec(buildSeedSql(now));
  });

  it('creates every PRD §5 table plus the sync tables', () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual([
      'audit_log',
      'blocks',
      'bookings',
      'day_rules',
      'devices',
      'holidays',
      'import_rows',
      'imports',
      'notification_log',
      'patient_requests',
      'patients',
      'procedures',
      'settings',
      'sync_ops',
      'sync_seq',
      'users',
    ]);
  });

  it('seeds a demo clinic with one doctor, staff, procedures, patients, holidays and bookings', () => {
    const count = (t: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()!.n);
    expect(db.prepare("SELECT count(*) AS n FROM users WHERE role = 'doctor'").get()!.n).toBe(1);
    expect(count('users')).toBe(3);
    expect(count('procedures')).toBe(5);
    expect(count('patients')).toBe(8);
    expect(count('holidays')).toBe(16);
    expect(count('bookings')).toBeGreaterThan(0);
    expect(count('settings')).toBe(1);
    // sync_seq equals the highest version handed out.
    const maxVersion = db
      .prepare(
        `SELECT max(v) AS v FROM (SELECT max(version) v FROM users UNION ALL SELECT max(version) FROM bookings
         UNION ALL SELECT max(version) FROM settings)`,
      )
      .get()!.v;
    expect(db.prepare('SELECT value FROM sync_seq WHERE id = 1').get()!.value).toBe(maxVersion);
  });

  it('is re-runnable (clears before inserting)', () => {
    db.exec(buildSeedSql(now));
    expect(db.prepare('SELECT count(*) AS n FROM patients').get()!.n).toBe(8);
  });

  it('enforces key constraints', () => {
    const insertPatient = (id: string, phone: string, note: string | null = null) =>
      db
        .prepare(
          'INSERT INTO patients (id, name, phone_e164, note, version, updated_at) VALUES (?, ?, ?, ?, 1, 0)',
        )
        .run(id, 'x', phone, note);
    expect(() => insertPatient('p-dup', '+251900000101')).toThrow(/UNIQUE/);
    expect(() => insertPatient('p-long', '+251900009999', 'x'.repeat(281))).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO bookings (id, patient_id, start_at, duration_min, status, created_by, version, updated_at) VALUES ('b', 'missing', 0, 60, 'approved', 'u', 1, 0)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO procedures (id, name_am, name_en, code, duration_min, color, version, updated_at) VALUES ('x', 'a', 'b', 'ABCD', 30, '#000', 1, 0)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('hot paths use indexes, never a full-table SCAN (PRD §19)', () => {
    const hot: [string, string, ...(string | number)[]][] = [
      ['sync pull: bookings', 'SELECT * FROM bookings WHERE version > ?', 10],
      ['sync pull: patients', 'SELECT * FROM patients WHERE version > ?', 10],
      [
        'day view',
        'SELECT * FROM bookings WHERE start_at >= ? AND start_at < ? AND deleted_at IS NULL',
        0,
        1,
      ],
      [
        'clash check',
        "SELECT id FROM bookings WHERE start_at < ? AND start_at >= ? AND status IN ('pending_approval','approved','arrived') AND deleted_at IS NULL",
        1,
        0,
      ],
      ['patient by phone', 'SELECT * FROM patients WHERE phone_e164 = ?', '+251900000101'],
      ['patient search by name prefix', 'SELECT * FROM patients WHERE name >= ? AND name < ?', 'አ', 'አ￿'],
      ['patient history', 'SELECT * FROM bookings WHERE patient_id = ? ORDER BY start_at DESC', 'x'],
      ['device auth', 'SELECT * FROM devices WHERE token_hash = ?', 'h'],
      ['blocks for a day', 'SELECT * FROM blocks WHERE start_at < ? AND end_at > ?', 1, 0],
    ];
    for (const [name, sql, ...params] of hot) {
      const p = plan(db, sql, ...params);
      expect(p, `${name}: ${p}`).not.toMatch(/SCAN (bookings|patients|devices|blocks)\b(?! USING)/);
    }
  });
});
