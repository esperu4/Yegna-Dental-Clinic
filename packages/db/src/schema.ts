/**
 * D1 schema (PRD §5). Conventions (docs/adr/0002-storage-conventions.md):
 * - ids: UUIDv7 text, generated on the client.
 * - instants: INTEGER epoch milliseconds, UTC (`*_at`).
 * - calendar dates: TEXT `YYYY-MM-DD`, clinic-local Gregorian.
 * - times of day: INTEGER minutes since local midnight (`*_min`, `open_at`…).
 * - syncable rows carry `version` (from `sync_seq`), `updated_at`, `updated_by`, `deleted_at`.
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  BOOKING_SOURCES,
  BOOKING_STATUSES,
  CALENDARS,
  IMPORT_ROW_DECISIONS,
  IMPORT_ROW_MATCHES,
  IMPORT_STATUSES,
  LOCALES,
  PATIENT_REQUEST_KINDS,
  PATIENT_REQUEST_STATUSES,
  ROLES,
} from '@yegna/shared';

const id = () => text('id').primaryKey();
const syncable = {
  version: integer('version').notNull(),
  updatedAt: integer('updated_at').notNull(),
  updatedBy: text('updated_by'),
  deletedAt: integer('deleted_at'),
};

/** Single-row counter: every touched syncable row gets the next value as its `version`. */
export const syncSeq = sqliteTable('sync_seq', {
  id: integer('id').primaryKey(),
  value: integer('value').notNull(),
});

/** Applied sync ops, so a re-sent op returns its original result (PRD §7.4). */
export const syncOps = sqliteTable(
  'sync_ops',
  {
    opId: text('op_id').primaryKey(),
    deviceId: text('device_id').notNull(),
    result: text('result').notNull(),
    appliedAt: integer('applied_at').notNull(),
  },
  (t) => [
    index('sync_ops_applied_at_idx').on(t.appliedAt),
    // Per-device daily op budget (apps/api/src/routes/sync.ts).
    index('sync_ops_device_applied_idx').on(t.deviceId, t.appliedAt),
  ],
);

export const users = sqliteTable(
  'users',
  {
    id: id(),
    name: text('name').notNull(),
    role: text('role', { enum: ROLES }).notNull(),
    pinHash: text('pin_hash'),
    pinSalt: text('pin_salt'),
    locale: text('locale', { enum: LOCALES }).notNull().default('am'),
    calendar: text('calendar', { enum: CALENDARS }).notNull().default('ethiopian'),
    telegramChatId: text('telegram_chat_id'),
    disabledAt: integer('disabled_at'),
    ...syncable,
  },
  (t) => [index('users_version_idx').on(t.version)],
);

export const devices = sqliteTable(
  'devices',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    label: text('label').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at'),
    revokedAt: integer('revoked_at'),
  },
  (t) => [uniqueIndex('devices_token_hash_uq').on(t.tokenHash), index('devices_user_idx').on(t.userId)],
);

/**
 * Server-side PIN rate limit (PRD §8, §18), counted atomically per key (a name, an IP, all
 * enrolments, setup). Each attempt is counted before the PIN is checked; reaching the limit
 * locks the key, and each further lockout doubles in length. Not synced.
 * See apps/api/src/lib/rateLimit.ts and docs/adr/0005-first-doctor-setup-code.md.
 */
export const authAttempts = sqliteTable('auth_attempts', {
  key: text('key').primaryKey(),
  /** Attempts in the current round. */
  failures: integer('failures').notNull(),
  /** Lockouts since the last successful sign-in; sets the next lockout's length. */
  locks: integer('locks').notNull().default(0),
  lockedUntil: integer('locked_until'),
  /** Random ticket of the last attempt that was let through (tells a request it was counted). */
  lastTicket: text('last_ticket'),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * One-time codes linking a team member's Telegram chat to their account (PRD §13): created in the
 * PWA, used once by `/start <code>` within 10 minutes. Only a SHA-256 of the code is kept.
 */
export const telegramLinkCodes = sqliteTable(
  'telegram_link_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('telegram_link_codes_user_idx').on(t.userId)],
);

export const patients = sqliteTable(
  'patients',
  {
    id: id(),
    name: text('name').notNull(),
    phoneE164: text('phone_e164').notNull(),
    note: text('note'),
    telegramChatId: text('telegram_chat_id'),
    telegramLinkedAt: integer('telegram_linked_at'),
    ...syncable,
  },
  (t) => [
    // Unique among live patients only: a deleted patient is erased and its number can be reused
    // (docs/adr/0007-erase-deleted-patients-and-needs-fixing.md).
    uniqueIndex('patients_phone_uq')
      .on(t.phoneE164)
      .where(sql`${t.deletedAt} IS NULL`),
    index('patients_name_idx').on(t.name),
    index('patients_version_idx').on(t.version),
    check('patients_note_len', sql`${t.note} IS NULL OR length(${t.note}) <= 280`),
  ],
);

export const procedures = sqliteTable(
  'procedures',
  {
    id: id(),
    nameAm: text('name_am').notNull(),
    nameEn: text('name_en').notNull(),
    code: text('code').notNull(),
    durationMin: integer('duration_min').notNull(),
    color: text('color').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    sort: integer('sort').notNull().default(0),
    ...syncable,
  },
  (t) => [
    uniqueIndex('procedures_code_uq').on(t.code),
    index('procedures_version_idx').on(t.version),
    check('procedures_code_len', sql`length(${t.code}) BETWEEN 1 AND 3`),
    check('procedures_duration_grid', sql`${t.durationMin} > 0 AND ${t.durationMin} % 15 = 0`),
  ],
);

export const bookings = sqliteTable(
  'bookings',
  {
    id: id(),
    patientId: text('patient_id')
      .notNull()
      .references(() => patients.id),
    procedureId: text('procedure_id').references(() => procedures.id),
    startAt: integer('start_at').notNull(),
    durationMin: integer('duration_min').notNull(),
    status: text('status', { enum: BOOKING_STATUSES }).notNull(),
    approvedBy: text('approved_by'),
    approvedAt: integer('approved_at'),
    patientConfirmedAt: integer('patient_confirmed_at'),
    /** Call list (PRD §8 item 8, ADR 0008): handled by the front desk, and the last unanswered call. */
    callHandledAt: integer('call_handled_at'),
    callHandledBy: text('call_handled_by'),
    callTriedAt: integer('call_tried_at'),
    source: text('source', { enum: BOOKING_SOURCES }).notNull().default('app'),
    importRowId: text('import_row_id'),
    cancelReason: text('cancel_reason'),
    clashWithId: text('clash_with_id'),
    note: text('note'),
    createdBy: text('created_by').notNull(),
    ...syncable,
  },
  (t) => [
    // Day view, clash check and sync window all range-scan start_at.
    index('bookings_start_idx').on(t.startAt),
    // Patient history: a patient's bookings, newest first.
    index('bookings_patient_start_idx').on(t.patientId, t.startAt),
    index('bookings_version_idx').on(t.version),
    index('bookings_status_start_idx').on(t.status, t.startAt),
    check('bookings_duration_grid', sql`${t.durationMin} > 0 AND ${t.durationMin} % 15 = 0`),
  ],
);

/** Doctor-only per-date overrides. Absent date ⇒ weekly defaults from `settings`. */
export const dayRules = sqliteTable(
  'day_rules',
  {
    date: text('date').primaryKey(),
    openAt: integer('open_at'),
    closeAt: integer('close_at'),
    lunchStart: integer('lunch_start'),
    lunchEnd: integer('lunch_end'),
    closed: integer('closed', { mode: 'boolean' }).notNull().default(false),
    note: text('note'),
    ...syncable,
  },
  (t) => [index('day_rules_version_idx').on(t.version)],
);

export const blocks = sqliteTable(
  'blocks',
  {
    id: id(),
    startAt: integer('start_at').notNull(),
    endAt: integer('end_at').notNull(),
    reason: text('reason'),
    ...syncable,
  },
  (t) => [
    index('blocks_start_idx').on(t.startAt),
    index('blocks_version_idx').on(t.version),
    check('blocks_range', sql`${t.endAt} > ${t.startAt}`),
  ],
);

export const holidays = sqliteTable(
  'holidays',
  {
    id: id(),
    date: text('date').notNull(),
    nameAm: text('name_am').notNull(),
    nameEn: text('name_en').notNull(),
    closed: integer('closed', { mode: 'boolean' }).notNull().default(true),
    ...syncable,
  },
  (t) => [index('holidays_date_idx').on(t.date), index('holidays_version_idx').on(t.version)],
);

/** Singleton row (`id = 'settings'`). */
export const settings = sqliteTable('settings', {
  id: text('id').primaryKey(),
  /** JSON `WeeklyDefaults` from @yegna/time (index 0 = Sunday; null = closed). */
  weeklyHours: text('weekly_hours').notNull(),
  unspecifiedDurationMin: integer('unspecified_duration_min').notNull().default(60),
  /** Local minutes since midnight. */
  patientReminderAt: integer('patient_reminder_at').notNull().default(1080),
  doctorSummaryAt: integer('doctor_summary_at').notNull().default(1140),
  defaultTemplate: text('default_template'),
  ...syncable,
});

export const patientRequests = sqliteTable(
  'patient_requests',
  {
    id: id(),
    bookingId: text('booking_id')
      .notNull()
      .references(() => bookings.id),
    patientId: text('patient_id')
      .notNull()
      .references(() => patients.id),
    kind: text('kind', { enum: PATIENT_REQUEST_KINDS }).notNull(),
    status: text('status', { enum: PATIENT_REQUEST_STATUSES }).notNull().default('open'),
    handledBy: text('handled_by'),
    ...syncable,
  },
  (t) => [
    index('patient_requests_status_idx').on(t.status),
    index('patient_requests_version_idx').on(t.version),
  ],
);

export const imports = sqliteTable(
  'imports',
  {
    id: id(),
    telegramFileId: text('telegram_file_id').notNull(),
    uploadedBy: text('uploaded_by').notNull(),
    template: text('template'),
    periodLabel: text('period_label'),
    status: text('status', { enum: IMPORT_STATUSES }).notNull().default('queued'),
    provider: text('provider'),
    rawResult: text('raw_result'),
    createdAt: integer('created_at').notNull(),
    ...syncable,
  },
  (t) => [index('imports_status_idx').on(t.status), index('imports_version_idx').on(t.version)],
);

export const importRows = sqliteTable(
  'import_rows',
  {
    id: id(),
    importId: text('import_id')
      .notNull()
      .references(() => imports.id),
    timeText: text('time_text'),
    nameText: text('name_text'),
    phoneText: text('phone_text'),
    codeText: text('code_text'),
    confidence: integer('confidence'),
    match: text('match', { enum: IMPORT_ROW_MATCHES }),
    decision: text('decision', { enum: IMPORT_ROW_DECISIONS }),
    bookingId: text('booking_id'),
    ...syncable,
  },
  (t) => [index('import_rows_import_idx').on(t.importId), index('import_rows_version_idx').on(t.version)],
);

export const notificationLog = sqliteTable(
  'notification_log',
  {
    id: id(),
    kind: text('kind').notNull(),
    targetChatId: text('target_chat_id').notNull(),
    /** Empty string (not NULL) for messages not tied to a booking, so the unique key still applies. */
    bookingId: text('booking_id').notNull().default(''),
    sentAt: integer('sent_at'),
    /** `dropped`: Telegram refused it for good (bot blocked, bad request); never retried. */
    status: text('status', { enum: ['pending', 'sent', 'failed', 'dropped'] }).notNull(),
  },
  (t) => [
    uniqueIndex('notification_log_idem_uq').on(t.kind, t.bookingId, t.targetChatId),
    index('notification_log_status_idx').on(t.status),
  ],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: id(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    userId: text('user_id'),
    deviceId: text('device_id'),
    action: text('action').notNull(),
    /** JSON diff. Ids only in logs elsewhere; this table is the one place values are kept. */
    diff: text('diff'),
    at: integer('at').notNull(),
  },
  (t) => [index('audit_log_entity_idx').on(t.entity, t.entityId), index('audit_log_at_idx').on(t.at)],
);
