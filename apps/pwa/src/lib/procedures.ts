/**
 * Procedure rules for the Doctor's procedures screen (PRD §5, §8 items 2 and 12). They mirror the
 * server's checks, so a mistake is shown inline instead of coming back as a refusal later.
 */
import { MAX_BOOKING_MIN, type ProcedureRow } from '@yegna/shared/client';
import { GRID_STEP_MIN } from '@yegna/time';
import type { MessageKey } from '../i18n/index.ts';

export interface ProcedureInput {
  nameAm: string;
  nameEn: string;
  code: string;
  durationMin: number;
  color: string;
  active: boolean;
}

export type ProcedureField = keyof ProcedureInput;

/** Colours for procedure chips: distinct, and readable with white text on both themes. */
export const PROCEDURE_COLORS = [
  '#1f7a4d',
  '#2563a8',
  '#8a3fa0',
  '#b8521d',
  '#a12d4f',
  '#5b6b16',
  '#0f766e',
  '#6b4f2a',
] as const;

/** Duration choices: the 15-minute grid up to 4 hours (longer bookings are rare). */
export const DURATION_CHOICES: readonly number[] = Array.from(
  { length: 16 },
  (_, i) => (i + 1) * GRID_STEP_MIN,
);

export const EMPTY_PROCEDURE: ProcedureInput = {
  nameAm: '',
  nameEn: '',
  code: '',
  durationMin: 30,
  color: PROCEDURE_COLORS[0],
  active: true,
};

/** Codes are short labels on paper sheets and chips: trimmed, Latin letters upper-cased. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Problems with a procedure, per field. `others` are the other live procedures (the code must be
 * unique among them).
 */
export function procedureProblems(
  input: ProcedureInput,
  others: readonly Pick<ProcedureRow, 'code'>[],
): Partial<Record<ProcedureField, MessageKey>> {
  const problems: Partial<Record<ProcedureField, MessageKey>> = {};
  if (!input.nameAm.trim()) problems.nameAm = 'error.required';
  if (!input.nameEn.trim()) problems.nameEn = 'error.required';
  const code = normalizeCode(input.code);
  if (!code) problems.code = 'error.required';
  else if (code.length > 3) problems.code = 'procedures.error.codeLength';
  else if (others.some((p) => normalizeCode(p.code) === code)) problems.code = 'procedures.error.codeTaken';
  if (
    !Number.isInteger(input.durationMin) ||
    input.durationMin <= 0 ||
    input.durationMin > MAX_BOOKING_MIN ||
    input.durationMin % GRID_STEP_MIN !== 0
  ) {
    problems.durationMin = 'procedures.error.duration';
  }
  return problems;
}

/** The fields to send: trimmed, code normalised. */
export function procedureFields(input: ProcedureInput, sort: number): Record<string, unknown> {
  return {
    nameAm: input.nameAm.trim(),
    nameEn: input.nameEn.trim(),
    code: normalizeCode(input.code),
    durationMin: input.durationMin,
    color: input.color,
    active: input.active,
    sort,
  };
}

/** Procedures in display order: active first, then by `sort`, then by code. */
export function sortProcedures<T extends Pick<ProcedureRow, 'active' | 'sort' | 'code'>>(
  list: readonly T[],
): T[] {
  return [...list].sort(
    (a, b) => Number(b.active) - Number(a.active) || a.sort - b.sort || a.code.localeCompare(b.code),
  );
}

/** `sort` for a new procedure: after the last one. */
export function nextSort(list: readonly Pick<ProcedureRow, 'sort'>[]): number {
  return list.reduce((max, p) => Math.max(max, p.sort + 1), 0);
}
