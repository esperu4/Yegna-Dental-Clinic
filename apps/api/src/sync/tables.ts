/** Sync entity → D1 table and key column. Day rules are keyed by date; the rest by id. */
import { blocks, bookings, dayRules, holidays, patients, procedures, settings, users } from '@yegna/db';

export const TABLES = {
  patients,
  bookings,
  procedures,
  dayRules,
  blocks,
  holidays,
  settings,
  users,
} as const;

export const KEY_COLUMNS = {
  patients: patients.id,
  bookings: bookings.id,
  procedures: procedures.id,
  dayRules: dayRules.date,
  blocks: blocks.id,
  holidays: holidays.id,
  settings: settings.id,
  users: users.id,
} as const;
