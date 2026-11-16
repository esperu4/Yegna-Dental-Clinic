/**
 * Backups (PRD §17, §20 M6): the encrypted file, retention, the nightly job with a fake Drive and
 * its failure alert, the weekly CSV, and a full export → restore round trip on a real local D1.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type EnrolResponse, type SyncOp, uuidv7 } from '@yegna/shared';
import { addDays, localDateOf, localToUtc, weekdayOf } from '@yegna/time';
import type { DriveClient } from '../src/backup/drive.ts';
import {
  type BackupData,
  BackupFormatError,
  FORMAT_VERSION,
  decodeBackup,
  encodeBackup,
  expiredBackups,
  importKey,
} from '../src/backup/format.ts';
import { afterRestoreStatements, restoreStatements, validateBackup } from '../src/backup/restoreSql.ts';
import { exportTables, weeklyCsvFiles } from '../src/jobs/backup.ts';
import { runHourly } from '../src/jobs/dispatch.ts';
import { getDb } from '../src/lib/db.ts';
import type { Notifier, OutgoingDocument, OutgoingMessage } from '../src/notify/notifier.ts';
import { type Call, caller, createTestEnv, resetDb, setupDoctor } from './helpers.ts';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7)));
const BACKUP = {
  BACKUP_KEY: KEY,
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REFRESH_TOKEN: 'refresh',
};
const DOCTOR_CHAT = '1001';

let env: Env;
let dispose: () => Promise<void>;
let call: Call;
let doctor: EnrolResponse;

beforeAll(async () => {
  ({ env, dispose } = await createTestEnv(BACKUP));
  call = caller(env);
});
afterAll(() => dispose());
beforeEach(async () => {
  await resetDb(env);
  doctor = await setupDoctor(call);
  await env.DB.prepare("UPDATE users SET telegram_chat_id = ?, locale = 'en' WHERE id = ?")
    .bind(DOCTOR_CHAT, doctor.user.id)
    .run();
});

class FakeTelegram implements Notifier {
  sent: { chatId: string; message: OutgoingMessage }[] = [];
  documents: { chatId: string; doc: OutgoingDocument }[] = [];
  async send(chatId: string, message: OutgoingMessage) {
    this.sent.push({ chatId, message });
  }
  async sendDocument(chatId: string, doc: OutgoingDocument) {
    this.documents.push({ chatId, doc });
  }
}

class FakeDrive {
  files: { id: string; name: string; date: string; content: Uint8Array }[] = [];
  failing = false;
  client: DriveClient = {
    upload: async (name, date, content) => {
      if (this.failing) throw new Error('drive down');
      const id = `f${this.files.length + 1}`;
      this.files.push({ id, name, date, content });
      return id;
    },
    list: async () => this.files.map(({ id, name, date }) => ({ id, name, date })),
    remove: async (id) => void (this.files = this.files.filter((f) => f.id !== id)),
    download: async (id) => this.files.find((f) => f.id === id)!.content,
  };
}

/** A patient (Amharic name with a quote, to test escaping) and a booking, by the Doctor. */
async function someData() {
  const patientId = uuidv7();
  const op = (entity: SyncOp['entity'], entityId: string, fields: Record<string, unknown>): SyncOp => ({
    opId: uuidv7(),
    entity,
    entityId,
    kind: 'create',
    fields,
    baseVersion: null,
    at: Date.now(),
    userId: doctor.user.id,
  });
  let monday = addDays(localDateOf(Date.now()), 2);
  while (weekdayOf(monday) !== 1) monday = addDays(monday, 1);
  const res = await call('POST', '/sync', {
    token: doctor.token,
    body: {
      deviceId: doctor.deviceId,
      cursor: 0,
      ops: [
        op('patients', patientId, { name: "አበበ ከበደ O'Neil", phoneE164: '+251911223344', note: '=SUM(A1)' }),
        op('bookings', uuidv7(), {
          patientId,
          procedureId: null,
          startAt: localToUtc(monday, 10 * 60),
          durationMin: 30,
        }),
      ],
    },
  });
  expect(res.status).toBe(200);
}

describe('backup file (PRD §17)', () => {
  it('round-trips, and refuses a wrong key or a damaged file', async () => {
    const key = await importKey(KEY);
    const data: BackupData = { format: FORMAT_VERSION, createdAt: 1, tables: { t: [{ a: 1, b: 'ሀ' }] } };
    const file = await encodeBackup(data, key);
    expect(new TextDecoder().decode(file.subarray(0, 4))).toBe('YDB1');
    expect(await decodeBackup(file, key)).toEqual(data);
    // The plain text never appears in the file.
    expect(new TextDecoder().decode(file)).not.toContain('ሀ');
    const other = await importKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(1))));
    await expect(decodeBackup(file, other)).rejects.toThrow(BackupFormatError);
    file[40] = file[40]! ^ 0xff;
    await expect(decodeBackup(file, key)).rejects.toThrow('wrong_key_or_damaged');
    await expect(importKey(btoa('short'))).rejects.toThrow('key_not_32_bytes');
  });

  it('keeps the last 30 backups and every 1st of the month', () => {
    const files = Array.from({ length: 70 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      return { id: d, date: d };
    });
    const gone = expiredBackups(files);
    expect(gone).toHaveLength(70 - 30 - 2); // Jan 1 and Feb 1 are older than the last 30, kept
    expect(gone).not.toContain('2026-01-01');
    expect(gone).not.toContain('2026-02-01');
    expect(gone).not.toContain('2026-03-11'); // newest
  });
});

describe('monthly retention is one setting (ADR 0012)', () => {
  it('limits the 1st-of-month backups when the clinic chooses a period', () => {
    const files = [
      '2025-01-01',
      '2025-10-01',
      '2026-10-01',
      ...Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`),
    ].map((d) => ({ id: d, date: d }));
    expect(expiredBackups(files, 30, Number.POSITIVE_INFINITY, '2026-11-30')).toEqual([]);
    expect(expiredBackups(files, 30, 12, '2026-11-30')).toEqual(['2025-10-01', '2025-01-01']);
  });
});

describe('export and restore (PRD §17 restore)', () => {
  it('restores every row into an emptied database, after checking the schema', async () => {
    await someData();
    const key = await importKey(KEY);
    const tables = await exportTables(env.DB);
    expect(tables.patients).toHaveLength(1);
    expect(Object.keys(tables).some((t) => t.startsWith('d1_') || t.startsWith('_cf_'))).toBe(false);
    const data = await decodeBackup(
      await encodeBackup({ format: FORMAT_VERSION, createdAt: Date.now(), tables }, key),
      key,
    );

    const schemaRows = await env.DB.prepare(
      "SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%' AND m.name NOT LIKE 'd1_%'",
    ).all<{ t: string; c: string }>();
    const schema: Record<string, string[]> = {};
    for (const r of schemaRows.results) (schema[r.t] ??= []).push(r.c);
    expect(validateBackup(data, schema)).toMatchObject({ ok: true, problems: [] });
    expect(validateBackup({ ...data, tables: { ...data.tables, ghosts: [] } }, schema).ok).toBe(false);
    const extraColumn = structuredClone(data);
    extraColumn.tables.patients![0]!.secret = 1;
    expect(validateBackup(extraColumn, schema).problems).toEqual(['table patients: unknown columns secret']);

    await resetDb(env);
    await env.DB.batch(restoreStatements(data).map((s) => env.DB.prepare(s)));
    const again = await exportTables(env.DB);
    for (const [t, rows] of Object.entries(tables)) expect(again[t], t).toEqual(rows);
    // After a restore, what the target knew is kept: a phone revoked since stays revoked (and with
    // the default, every phone is signed out), a patient erased since is erased again.
    const patientId = tables.patients![0]!.id as string;
    const after = afterRestoreStatements(
      { revokedDevices: [], erasedPatients: [patientId] },
      Date.now(),
      true,
    );
    await env.DB.batch(after.map((s) => env.DB.prepare(s)));
    const erased = await env.DB.prepare(
      'SELECT name, phone_e164, note, deleted_at FROM patients WHERE id = ?',
    )
      .bind(patientId)
      .first<{ name: string; phone_e164: string; note: string | null; deleted_at: number | null }>();
    expect(erased).toMatchObject({ name: '', phone_e164: '', note: null });
    expect(erased!.deleted_at).toBeGreaterThan(0);
    const signedOut = afterRestoreStatements({ revokedDevices: [], erasedPatients: [] }, Date.now());
    await env.DB.batch(signedOut.map((s) => env.DB.prepare(s)));
    const live = await env.DB.prepare('SELECT count(*) AS n FROM devices WHERE revoked_at IS NULL').first<{
      n: number;
    }>();
    expect(live!.n).toBe(0);
    await resetDb(env);
    await env.DB.batch(restoreStatements(data).map((s) => env.DB.prepare(s)));
    // The restored clinic works: the Doctor's device token still signs in.
    const res = await call('POST', '/sync', {
      token: doctor.token,
      body: { deviceId: doctor.deviceId, cursor: 0, ops: [] },
    });
    expect(res.status).toBe(200);
  });
});

describe('nightly backup job (PRD §16, §17)', () => {
  const today = localDateOf(Date.now());
  const at = (hh: number) => localToUtc(today, hh * 60);

  it('from 02:00, once a day, to Drive; expired backups are removed', async () => {
    await someData();
    const drive = new FakeDrive();
    for (let i = 0; i < 31; i++)
      drive.files.push({
        id: `old${i}`,
        name: 'x',
        date: `2025-11-${String(i + 1).padStart(2, '0')}`,
        content: new Uint8Array(),
      });
    const telegram = new FakeTelegram();
    await runHourly(env, at(1), telegram, undefined, drive.client);
    expect(drive.files.filter((f) => f.date === today)).toHaveLength(0);
    await runHourly(env, at(2), telegram, undefined, drive.client);
    await runHourly(env, at(3), telegram, undefined, drive.client);
    const mine = drive.files.filter((f) => f.date === today);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.name).toBe(`yegna-backup-local-${today}.ydb`);
    // 30 newest kept (today + 29 old) plus 2025-11-01.
    expect(drive.files).toHaveLength(31);
    expect(drive.files.some((f) => f.date === '2025-11-01')).toBe(true);
    const data = await decodeBackup(mine[0]!.content, await importKey(KEY));
    expect(data.tables.patients).toHaveLength(1);
    expect(telegram.sent).toHaveLength(0);
  });

  it('a failure is retried each hour and the Doctor is told once', async () => {
    const drive = new FakeDrive();
    drive.failing = true;
    const telegram = new FakeTelegram();
    await runHourly(env, at(2), telegram, undefined, drive.client);
    await runHourly(env, at(3), telegram, undefined, drive.client);
    const alerts = telegram.sent.filter((s) => s.message.text.includes('backup'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.chatId).toBe(DOCTOR_CHAT);
    drive.failing = false;
    await runHourly(env, at(4), telegram, undefined, drive.client);
    expect(drive.files).toHaveLength(1);
  });

  it('does nothing without its secrets', async () => {
    const drive = new FakeDrive();
    const saved = env.BACKUP_KEY!;
    delete env.BACKUP_KEY;
    try {
      await runHourly(env, at(2), new FakeTelegram(), undefined, drive.client);
    } finally {
      env.BACKUP_KEY = saved;
    }
    expect(drive.files).toHaveLength(0);
  });
});

describe('weekly CSV (PRD §16, §17.3)', () => {
  it('Sunday from 21:00, once, to the Doctor; formulas are kept as text', async () => {
    await someData();
    let sunday = localDateOf(Date.now());
    while (weekdayOf(sunday) !== 0) sunday = addDays(sunday, 1);
    const telegram = new FakeTelegram();
    await runHourly(env, localToUtc(sunday, 20 * 60), telegram);
    expect(telegram.documents).toHaveLength(0);
    await runHourly(env, localToUtc(sunday, 21 * 60), telegram);
    await runHourly(env, localToUtc(sunday, 22 * 60), telegram);
    expect(telegram.documents.map((d) => d.doc.filename)).toEqual([
      `patients-${sunday}.csv`,
      `bookings-${sunday}.csv`,
    ]);
    const files = await weeklyCsvFiles(getDb(env.DB), Date.now());
    // Keep the BOM (TextDecoder drops it by default) to check it is there.
    const patients = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(files.patients);
    expect(patients.charCodeAt(0)).toBe(0xfeff);
    expect(patients).toContain("'=SUM(A1)");
    expect(patients).toContain("አበበ ከበደ O'Neil");
    expect(new TextDecoder().decode(files.bookings).split('\r\n')).toHaveLength(3); // header, row, end
  });
});
