/** Request/response shapes for accounts and devices (PRD §8 item 1, §9, §18). */
import { z } from 'zod';
import type { ROLES } from './enums.ts';
import { CALENDARS, LOCALES } from './enums.ts';
import { isUuidv7 } from './ids.ts';
import { DOCTOR_PIN_LENGTH, PIN_PATTERN, isTrivialPin } from './rules.ts';

export const pinSchema = z.string().regex(PIN_PATTERN, 'pin_format');

/** A PIN being set (setup, new staff, PIN reset): right format and not trivial. */
export const newPinSchema = pinSchema.refine((p) => !isTrivialPin(p), 'pin_trivial');

export const doctorPinSchema = newPinSchema.refine(
  (p) => p.length === DOCTOR_PIN_LENGTH,
  'pin_doctor_length',
);
export const uuidv7Schema = z.string().refine(isUuidv7, 'uuidv7');
const nameSchema = z.string().trim().min(1).max(80);
const deviceLabelSchema = z.string().trim().min(1).max(60);

export const setupRequest = z.object({
  code: z.string().min(1).max(200),
  userId: uuidv7Schema,
  name: nameSchema,
  pin: doctorPinSchema,
  deviceLabel: deviceLabelSchema,
  locale: z.enum(LOCALES).default('am'),
  calendar: z.enum(CALENDARS).default('ethiopian'),
});
export type SetupRequest = z.infer<typeof setupRequest>;

export const enrolRequest = z.object({
  name: nameSchema,
  pin: pinSchema,
  deviceLabel: deviceLabelSchema,
});
export type EnrolRequest = z.infer<typeof enrolRequest>;

export const createUserRequest = z.object({
  id: uuidv7Schema,
  name: nameSchema,
  pin: newPinSchema,
});
export type CreateUserRequest = z.infer<typeof createUserRequest>;

export const updateUserRequest = z
  .object({
    name: nameSchema.optional(),
    pin: newPinSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'empty');
export type UpdateUserRequest = z.infer<typeof updateUserRequest>;

export const updateMeRequest = z
  .object({ locale: z.enum(LOCALES).optional(), calendar: z.enum(CALENDARS).optional() })
  .refine((v) => Object.keys(v).length > 0, 'empty');
export type UpdateMeRequest = z.infer<typeof updateMeRequest>;

export interface SessionUser {
  id: string;
  name: string;
  role: (typeof ROLES)[number];
  locale: (typeof LOCALES)[number];
  calendar: (typeof CALENDARS)[number];
}

export interface EnrolResponse {
  token: string;
  deviceId: string;
  user: SessionUser;
}

export interface DeviceInfo {
  id: string;
  userId: string;
  userName: string;
  label: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

/** Error codes returned as `{ error }`. The PWA maps each to a translated message. */
export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'revoked'
  | 'forbidden'
  | 'not_found'
  | 'invalid_credentials'
  | 'locked'
  | 'setup_disabled'
  | 'already_set_up'
  | 'name_taken'
  | 'cannot_change_self'
  | 'conflict';
