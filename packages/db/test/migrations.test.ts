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
      'auth_attempts',
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
      'telegram_link_codes',
      'users',
    ]);
  });

  it('seeds a demo clinic (procedures, patients, holidays, bookings) and no users', () => {
    const count = (t: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()!.n);
    // Users come only from the setup screen, which needs an empty users table.
    expect(count('users')).toBe(0);
    expect(count('procedures')).toBe(5);
    expect(count('patients')).toBe(8);
    expect(count('holidays')).toBe(16);
    expect(count('bookings')).toBeGreaterThan(0);
    expect(count('settings')).toBe(1);
    // sync_seq equals the highest version handed out.
    const maxVersion = db
      .prepare(
        `SELECT max(v) AS v FROM (SELECT max(version) v FROM procedures UNION ALL SELECT max(version) FROM bookings
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
      // Live patients only: the phone index is partial (deleted patients are erased, ADR 0007).
      [
        'patient by phone',
        'SELECT * FROM patients WHERE phone_e164 = ? AND deleted_at IS NULL',
        '+251900000101',
      ],
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

describe('0003 + 0004: erase deleted patients (docs/adr/0007)', () => {
  it('erases patients deleted before the change and frees their phones', () => {
    const db = new DatabaseSync(':memory:');
    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const run = (f: string) => {
      for (const stmt of readFileSync(join(MIGRATIONS, f), 'utf8').split('--> statement-breakpoint')) {
        if (stmt.trim()) db.exec(stmt);
      }
    };
    files.filter((f) => f < '0003').forEach(run);
    db.exec(`INSERT INTO patients (id, name, phone_e164, note, version, updated_at, deleted_at)
      VALUES ('p1', 'Old Patient', '+251911000001', 'note', 1, 0, 5),
             ('p2', 'Live Patient', '+251911000002', NULL, 2, 0, NULL)`);
    db.exec(`INSERT INTO audit_log (id, entity, entity_id, action, diff, at)
      VALUES ('a1', 'patients', 'p1', 'create', '{"name":"Old Patient"}', 0),
             ('a2', 'patients', 'p2', 'create', '{"name":"Live Patient"}', 0),
             ('a3', 'patients', 'px', 'rejected:phone_taken', '{"kind":"create","fields":{"name":"Someone"}}', 0),
             ('a4', 'bookings', 'b1', 'create', '{"note":"Old Patient sister 0911","status":"approved"}', 0),
             ('a5', 'bookings', 'bx', 'rejected:in_block', '{"kind":"create","fields":{"patientId":"p1","note":"call 0911"}}', 0)`);
    db.exec(`INSERT INTO bookings (id, patient_id, start_at, duration_min, status, source, created_by, note, version, updated_at)
      VALUES ('b1', 'p1', 0, 60, 'done', 'app', 'u', 'Old Patient sister 0911', 3, 0),
             ('b2', 'p2', 0, 60, 'done', 'app', 'u', 'keep me', 4, 0)`);
    files.filter((f) => f >= '0003').forEach(run);

    // 0004: the deleted patient's booking free text and its audit values; refused patient values.
    expect(db.prepare("SELECT note, version FROM bookings WHERE id = 'b1'").get()).toEqual({
      note: null,
      version: 1,
    });
    expect(db.prepare("SELECT note FROM bookings WHERE id = 'b2'").get()).toEqual({ note: 'keep me' });
    expect(db.prepare("SELECT diff FROM audit_log WHERE id = 'a3'").get()).toEqual({ diff: null });
    expect(db.prepare("SELECT diff FROM audit_log WHERE id = 'a4'").get()).toEqual({
      diff: '{"status":"approved"}',
    });
    expect(db.prepare("SELECT diff FROM audit_log WHERE id = 'a5'").get()).toEqual({
      diff: '{"kind":"create","fields":{"patientId":"p1"}}',
    });

    expect(db.prepare("SELECT name, phone_e164, note FROM patients WHERE id = 'p1'").get()).toEqual({
      name: '',
      phone_e164: '',
      note: null,
    });
    expect(db.prepare("SELECT diff FROM audit_log WHERE id = 'a1'").get()).toEqual({ diff: null });
    expect(db.prepare("SELECT diff FROM audit_log WHERE id = 'a2'").get()).toEqual({
      diff: '{"name":"Live Patient"}',
    });
    // The freed number can be used again; live numbers stay unique.
    db.exec(
      `INSERT INTO patients (id, name, phone_e164, version, updated_at) VALUES ('p3', 'New', '+251911000001', 3, 0)`,
    );
    expect(() =>
      db.exec(
        `INSERT INTO patients (id, name, phone_e164, version, updated_at) VALUES ('p4', 'Dup', '+251911000002', 4, 0)`,
      ),
    ).toThrow(/UNIQUE/);
  });
});
