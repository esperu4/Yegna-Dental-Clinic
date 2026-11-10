/**
 * `/sync` wire types (PRD §7.4, docs/adr/0006-sync-protocol.md). Types only, so the PWA can use
 * them without the zod schemas in `sync.ts`.
 */
import type { BookingError, WeeklyDefaults } from '@yegna/time';
import type { StatusChangeError } from './bookingLifecycle.ts';
import type { BookingSource, BookingStatus, Role } from './enums.ts';

/** Entities a device may write through `/sync`. */
export const WRITE_ENTITIES = [
  'patients',
  'bookings',
  'procedures',
  'dayRules',
  'blocks',
  'holidays',
  'settings',
] as const;
export type WriteEntity = (typeof WRITE_ENTITIES)[number];

/** Entities a device receives. Users are managed through `/admin` and only pulled here. */
export const PULL_ENTITIES = [...WRITE_ENTITIES, 'users'] as const;
export type PullEntity = (typeof PULL_ENTITIES)[number];

export const OP_KINDS = ['create', 'update', 'delete'] as const;
export type OpKind = (typeof OP_KINDS)[number];

/** Ops per `/sync` call; the client loops when its outbox holds more (PRD §7.4). */
export const MAX_OPS_PER_SYNC = 200;
/** Rows per pull page; `more: true` tells the client to call again with `newCursor`. */
export const PULL_PAGE_SIZE = 500;
/** The working copy holds bookings from today − 30 days to today + 120 days (PRD §7.1). */
export const WINDOW_PAST_DAYS = 30;
export const WINDOW_FUTURE_DAYS = 120;
/** Longest booking accepted; also bounds the clash-check index range. */
export const MAX_BOOKING_MIN = 8 * 60;
/** The one `settings` row. */
export const SETTINGS_ID = 'settings';

export interface SyncOp {
  /** UUIDv7 made on the device; re-sending the same op returns its original result. */
  opId: string;
  entity: WriteEntity;
  /** UUIDv7, except `dayRules` (the date, `YYYY-MM-DD`) and `settings` (`'settings'`). */
  entityId: string;
  kind: OpKind;
  /** Fields set by this op. Empty for `delete`. */
  fields: Record<string, unknown>;
  /** The row version the device last saw; null for `create`. */
  baseVersion: number | null;
  /** When the user acted, device clock (epoch ms). Used on the device; the server stamps its own time. */
  at: number;
  userId: string;
}

export interface SyncRequest {
  deviceId: string;
  /** Highest `version` already applied on the device; 0 on first install. */
  cursor: number;
  /**
   * True while the device is filling its working copy for the first time: bookings older than the
   * window are then left out (PRD §7.1). Later pulls send every change, old bookings included,
   * so a device never keeps a stale copy of a row it holds.
   */
  initial?: boolean;
  ops: SyncOp[];
}

export type SyncRejectReason =
  | 'invalid'
  | 'forbidden'
  | 'not_found'
  | 'exists'
  | 'phone_taken'
  | 'code_taken'
  | 'patient_not_found'
  | 'procedure_not_found'
  | StatusChangeError
  | BookingError;

export type OpResult =
  | { opId: string; outcome: 'applied'; version: number }
  /** Stored with `status = clash`; `winner` is the booking that keeps the slot (PRD §7.4). */
  | { opId: string; outcome: 'clash'; version: number; winner: string }
  /**
   * Stored with `status = needs_fixing`: it breaks a clinic-hours rule (`reason`) that the device
   * did not know about yet. Shown in red until moved (docs/adr/0007).
   */
  | { opId: string; outcome: 'needs_fixing'; version: number; reason: BookingError }
  /** Not stored. The entity's current server row (if any) is in `changes`, so the device can roll back. */
  | { opId: string; outcome: 'rejected'; reason: SyncRejectReason };

interface SyncMeta {
  version: number;
  updatedAt: number;
  updatedBy: string | null;
  deletedAt: number | null;
}

export interface PatientRow extends SyncMeta {
  id: string;
  name: string;
  phoneE164: string;
  note: string | null;
  /** Whether the patient linked Telegram. The chat id itself never leaves the server. */
  telegramLinked: boolean;
}

export interface BookingRow extends SyncMeta {
  id: string;
  patientId: string;
  procedureId: string | null;
  startAt: number;
  durationMin: number;
  status: BookingStatus;
  approvedBy: string | null;
  approvedAt: number | null;
  patientConfirmedAt: number | null;
  source: BookingSource;
  cancelReason: string | null;
  clashWithId: string | null;
  note: string | null;
  createdBy: string;
}

export interface ProcedureRow extends SyncMeta {
  id: string;
  nameAm: string;
  nameEn: string;
  code: string;
  durationMin: number;
  color: string;
  active: boolean;
  sort: number;
}

export interface DayRuleRow extends SyncMeta {
  date: string;
  openAt: number | null;
  closeAt: number | null;
  lunchStart: number | null;
  lunchEnd: number | null;
  closed: boolean;
  note: string | null;
}

export interface BlockRow extends SyncMeta {
  id: string;
  startAt: number;
  endAt: number;
  reason: string | null;
}

export interface HolidayRow extends SyncMeta {
  id: string;
  date: string;
  nameAm: string;
  nameEn: string;
  closed: boolean;
}

export interface SettingsRow extends SyncMeta {
  id: typeof SETTINGS_ID;
  weeklyHours: WeeklyDefaults;
  unspecifiedDurationMin: number;
  patientReminderAt: number;
  doctorSummaryAt: number;
  defaultTemplate: string | null;
}

/** Names and roles only (PRD §7.1). */
export interface UserRow extends SyncMeta {
  id: string;
  name: string;
  role: Role;
  disabledAt: number | null;
}

export interface RowOf {
  patients: PatientRow;
  bookings: BookingRow;
  procedures: ProcedureRow;
  dayRules: DayRuleRow;
  blocks: BlockRow;
  holidays: HolidayRow;
  settings: SettingsRow;
  users: UserRow;
}

/**
 * A deleted row as sent to devices: its key and meta only. Devices drop the row's content; a
 * deleted patient's name and phone never leave the server again (PRD §18).
 */
export interface Tombstone extends SyncMeta {
  id?: string;
  date?: string;
  deletedAt: number;
}

/** Changed rows grouped by entity, so entity names are not repeated per row (PRD §7.8). */
export type SyncChanges = { [E in PullEntity]?: (RowOf[E] | Tombstone)[] };

/** Ops a device may send in 24 h (PRD §19: keeps one runaway device from using up the free D1 writes). */
export const DEVICE_DAILY_OPS = 2_000;

export interface SyncResponse {
  /**
   * Answers for the first `results.length` ops, in order. The server may answer fewer than it was
   * sent (it stays inside the D1 per-request limit): the device keeps the rest and calls again.
   */
  results: OpResult[];
  changes: SyncChanges;
  newCursor: number;
  /** More changes are waiting: call again with `newCursor` (and no ops). */
  more: boolean;
  /**
   * Set when the device is past `DEVICE_DAILY_OPS`: its new ops were held back. It should send
   * only pulls (no ops) for this long, then try its outbox again.
   */
  retryOpsAfterMs?: number;
}

/** The key a row is stored under on the device and on the server. */
export function rowKey<E extends PullEntity>(entity: E, row: RowOf[E] | Tombstone): string {
  return entity === 'dayRules' ? (row as DayRuleRow).date : (row as { id: string }).id;
}
