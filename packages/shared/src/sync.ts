/**
 * `/sync` validation (PRD §7.4, docs/adr/0006-sync-protocol.md). The request envelope is checked
 * first; each op's `fields` are then checked per entity and kind, so one bad op is rejected
 * without failing the rest of the batch.
 */
import { GRID_STEP_MIN, parseIsoDate } from '@yegna/time';
import { z } from 'zod';
import { CALL_OUTCOMES, PATIENT_NOTE_MAX } from './enums.ts';
import { uuidv7Schema } from './auth.ts';
import { isUuidv7 } from './ids.ts';
import { normalizePhone } from './phone.ts';
import {
  MAX_BOOKING_MIN,
  MAX_OPS_PER_SYNC,
  OP_KINDS,
  type OpKind,
  SETTINGS_ID,
  WRITE_ENTITIES,
  type WriteEntity,
} from './syncTypes.ts';

const MIN_PER_DAY = 1440;
/** Paper template codes (PRD §11). */
export const TEMPLATE_CODES = ['F', 'C', 'O'] as const;

const isoDate = z.string().refine((d) => {
  try {
    parseIsoDate(d);
    return true;
  } catch {
    return false;
  }
}, 'date');
const instant = z.number().int().nonnegative();
const gridInstant = instant.refine((ms) => ms % (GRID_STEP_MIN * 60_000) === 0, 'off_grid');
const dayMinute = z.number().int().min(0).max(MIN_PER_DAY);
const gridDuration = z
  .number()
  .int()
  .min(GRID_STEP_MIN)
  .max(MAX_BOOKING_MIN)
  .refine((m) => m % GRID_STEP_MIN === 0);
/**
 * Control characters and bidi overrides are removed from free text: names and notes are later
 * shown in Telegram messages and on printed sheets, where they could hide or reorder text.
 * Newlines are kept in multi-line fields (notes).
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_OR_NEWLINE = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
const clean = (pattern: RegExp) => z.string().transform((s) => s.replace(pattern, '').trim());

const text = (max: number) => clean(UNSAFE_OR_NEWLINE).pipe(z.string().min(1).max(max));
const optionalText = (max: number) =>
  clean(UNSAFE)
    .pipe(z.string().max(max))
    .nullable()
    .transform((s) => (s ? s : null));
/** A phone already normalised on the device: must be E.164 exactly as `normalizePhone` makes it. */
const phoneE164 = z.string().refine((p) => {
  const r = normalizePhone(p);
  return r.ok && r.e164 === p;
}, 'phone');

const patientFields = z.object({ name: text(80), phoneE164, note: optionalText(PATIENT_NOTE_MAX) }).strict();

const bookingCreate = z
  .object({
    patientId: uuidv7Schema,
    procedureId: uuidv7Schema.nullable(),
    startAt: gridInstant,
    durationMin: gridDuration,
    note: optionalText(PATIENT_NOTE_MAX).optional(),
  })
  .strict();

/**
 * A booking update either changes the status (a card action), records a call-list outcome, or
 * edits the booking; never two of these at once.
 */
const bookingUpdate = z
  .object({
    procedureId: uuidv7Schema.nullable(),
    startAt: gridInstant,
    durationMin: gridDuration,
    note: optionalText(PATIENT_NOTE_MAX),
    status: z.enum(['approved', 'arrived', 'done', 'cancelled', 'no_show']),
    cancelReason: optionalText(200),
    call: z.enum(CALL_OUTCOMES),
    /** The start time the call was about: a call made before a move must not mark the new time. */
    callFor: z.number().int(),
  })
  .partial()
  .strict()
  .refine((f) => Object.keys(f).length > 0, 'empty')
  .refine((f) => (f.call === undefined) === (f.callFor === undefined), 'call_without_time')
  .refine((f) => f.call === undefined || Object.keys(f).length === 2, 'call_with_other_change')
  .refine(
    (f) => f.status === undefined || (f.startAt === undefined && f.durationMin === undefined),
    'status_with_move',
  )
  .refine((f) => f.cancelReason === undefined || f.status === 'cancelled', 'reason_without_cancel');

const procedureFields = z
  .object({
    nameAm: text(60),
    nameEn: text(60),
    code: z.string().trim().min(1).max(3),
    durationMin: gridDuration,
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    active: z.boolean(),
    sort: z.number().int().min(0).max(10_000),
  })
  .strict();

const dayRuleFields = z
  .object({
    openAt: dayMinute.nullable(),
    closeAt: dayMinute.nullable(),
    lunchStart: dayMinute.nullable(),
    lunchEnd: dayMinute.nullable(),
    closed: z.boolean(),
    note: optionalText(200),
  })
  .strict();

const blockFields = z
  .object({ startAt: gridInstant, endAt: gridInstant, reason: optionalText(200) })
  .strict();

const holidayFields = z
  .object({ date: isoDate, nameAm: text(60), nameEn: text(60), closed: z.boolean() })
  .strict();

const weekdayHours = z
  .object({
    openAt: dayMinute,
    closeAt: dayMinute,
    lunchStart: dayMinute.nullable(),
    lunchEnd: dayMinute.nullable(),
  })
  .strict()
  .refine((h) => h.openAt < h.closeAt, 'open_before_close')
  .refine((h) => (h.lunchStart === null) === (h.lunchEnd === null), 'lunch_pair')
  .refine((h) => h.lunchStart === null || h.lunchEnd === null || h.lunchStart < h.lunchEnd, 'lunch_order');

const settingsFields = z
  .object({
    weeklyHours: z.tuple([
      weekdayHours.nullable(),
      weekdayHours.nullable(),
      weekdayHours.nullable(),
      weekdayHours.nullable(),
      weekdayHours.nullable(),
      weekdayHours.nullable(),
      weekdayHours.nullable(),
    ]),
    unspecifiedDurationMin: gridDuration,
    patientReminderAt: dayMinute.max(MIN_PER_DAY - 1),
    doctorSummaryAt: dayMinute.max(MIN_PER_DAY - 1),
    defaultTemplate: z.enum(TEMPLATE_CODES).nullable(),
  })
  .strict();

type FieldSchemas = { create: z.ZodType | null; update: z.ZodType | null; delete: boolean };

/** What each entity accepts per op kind. `null` = kind not allowed for this entity. */
const FIELDS: Record<WriteEntity, FieldSchemas> = {
  patients: {
    create: patientFields.extend({ note: patientFields.shape.note.optional() }),
    update: nonEmptyPartial(patientFields),
    delete: true,
  },
  // Bookings are never deleted: they are cancelled with a reason (PRD §8 item 6).
  bookings: { create: bookingCreate, update: bookingUpdate, delete: false },
  procedures: { create: procedureFields, update: nonEmptyPartial(procedureFields), delete: true },
  // Keyed by date: a create on an existing date is applied as an update (upsert).
  dayRules: { create: checkedDayRule(dayRuleFields), update: nonEmptyPartial(dayRuleFields), delete: true },
  blocks: { create: checkedBlock(blockFields), update: nonEmptyPartial(blockFields), delete: true },
  holidays: { create: holidayFields, update: nonEmptyPartial(holidayFields), delete: true },
  // The singleton row: create and update both upsert it; it cannot be deleted.
  settings: { create: settingsFields, update: nonEmptyPartial(settingsFields), delete: false },
};

function nonEmptyPartial<T extends z.ZodObject>(schema: T) {
  return schema.partial().refine((f) => Object.keys(f).length > 0, 'empty');
}

function checkedDayRule(schema: typeof dayRuleFields) {
  return schema.refine(
    (r) => r.openAt === null || r.closeAt === null || r.openAt < r.closeAt,
    'open_before_close',
  );
}

function checkedBlock(schema: typeof blockFields) {
  return schema.refine((b) => b.endAt > b.startAt, 'end_after_start');
}

const ENTITY_IDS: Record<WriteEntity, (id: string) => boolean> = {
  patients: isUuidv7,
  bookings: isUuidv7,
  procedures: isUuidv7,
  dayRules: (id) => isoDate.safeParse(id).success,
  blocks: isUuidv7,
  holidays: isUuidv7,
  settings: (id) => id === SETTINGS_ID,
};

const opSchema = z
  .object({
    opId: uuidv7Schema,
    entity: z.enum(WRITE_ENTITIES),
    entityId: z.string().max(64),
    kind: z.enum(OP_KINDS),
    fields: z.record(z.string(), z.unknown()),
    baseVersion: z.number().int().nonnegative().nullable(),
    at: instant,
    userId: uuidv7Schema,
  })
  .strict();

/**
 * The envelope only. A malformed envelope fails the whole request (400); an op whose entity id
 * or fields are wrong is rejected on its own by `parseOpFields`.
 */
export const syncRequestSchema = z
  .object({
    deviceId: uuidv7Schema,
    cursor: z.number().int().nonnegative(),
    initial: z.boolean().optional(),
    ops: z.array(opSchema).max(MAX_OPS_PER_SYNC),
  })
  .strict()
  .refine((r) => new Set(r.ops.map((o) => o.opId)).size === r.ops.length, 'duplicate_op');

/** Checked, normalised fields of one op, or null if the op is invalid for its entity and kind. */
export function parseOpFields(
  entity: WriteEntity,
  kind: OpKind,
  entityId: string,
  fields: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!ENTITY_IDS[entity](entityId)) return null;
  const spec = FIELDS[entity];
  if (kind === 'delete') return spec.delete && Object.keys(fields).length === 0 ? {} : null;
  const schema = spec[kind];
  if (!schema) return null;
  const parsed = schema.safeParse(fields);
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}
