/**
 * The reading prompt (PRD §12): versioned, JSON only, names kept exactly as written (Ge'ez or
 * Latin), `null` for anything unreadable rather than a guess. Change the text ⇒ bump the version,
 * so evaluation results can be compared across versions.
 */
import type { ReadInput, TemplateCode } from './types.ts';

export const PROMPT_VERSION = 'v1';

const LAYOUTS: Record<TemplateCode, string> = {
  F: 'Template F ("Familiar"): one week, Monday–Saturday columns, hourly rows in Ethiopian time. Each hour cell has up to 3 entries: a minute box (:__), a name line, 10 phone digit boxes and a procedure code box.',
  C: 'Template C ("Clear"): half a week (Mon–Wed or Thu–Sat), same structure as F with larger cells.',
  O: 'Template O ("Overview"): one month, a calendar grid (Monday–Saturday × weeks). Each day cell has up to 6 numbered lines with an hour and a name only; there are no phone numbers.',
  unknown: 'The template is not known; it is one of the clinic’s weekly or monthly booking sheets.',
};

/** JSON Schema of the answer, for readers that support schema-constrained output. */
export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sheetId', 'rows'],
  properties: {
    sheetId: { type: ['string', 'null'] },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['day', 'time', 'name', 'phone', 'code', 'confidence'],
        properties: {
          day: { type: ['string', 'null'] },
          time: { type: ['string', 'null'] },
          name: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
          code: { type: ['string', 'null'] },
          confidence: { type: 'number' },
        },
      },
    },
  },
} as const;

export function buildPrompt(input: Pick<ReadInput, 'template' | 'procedures'>): string {
  const codes = input.procedures.length
    ? input.procedures.map((p) => `${p.code} = ${p.name}`).join('; ')
    : '(none)';
  return [
    'You read a photo of a handwritten dental clinic booking sheet from Ethiopia.',
    LAYOUTS[input.template],
    'Times are Ethiopian (ET) hours, e.g. 3:00 is the first morning hour. Dates are Ethiopian.',
    `Procedure codes on this sheet: ${codes}.`,
    'The sheet ID is printed in large letters at the top, like YD-F-2019-T03W2.',
    'Return JSON only, no prose, exactly in this shape:',
    '{"sheetId": string|null, "rows": [{"day": string|null, "time": string|null, "name": string|null, "phone": string|null, "code": string|null, "confidence": number}]}',
    'Rules:',
    '- One row per handwritten entry; skip empty lines.',
    '- day: the weekday column as mon, tue, wed, thu, fri or sat; on the monthly sheet, the day of the month.',
    '- time: the hour of the row plus the minutes written, as H:MM (ET).',
    '- name: exactly as written, in Ge’ez (Amharic) or Latin script; never translate or transliterate.',
    '- phone: the digits as written, no spaces.',
    '- code: the procedure code as written.',
    '- Use null for anything you cannot read. Never guess.',
    '- confidence: 0 to 1, how sure you are of the whole row.',
  ].join('\n');
}
