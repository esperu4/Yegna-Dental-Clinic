/**
 * Turns a reader's raw answer into a `ReadResult`, strictly: JSON only (a fenced block or prose
 * around one object is tolerated), fields trimmed, empty ⇒ absent, confidence clamped to 0–1,
 * blank rows dropped, at most `MAX_ROWS`. Anything else is `bad_output`, never a guess.
 */
import { z } from 'zod';
import { type ReadResult, type ReadRow, ReaderError } from './types.ts';

/** A month sheet has 6 days × ~5 weeks × 6 lines; anything beyond that is a broken answer. */
export const MAX_ROWS = 200;
const MAX_FIELD = 120;

const text = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => {
    if (v === null || v === undefined) return undefined;
    const s = String(v).trim().slice(0, MAX_FIELD);
    return s && s.toLowerCase() !== 'null' ? s : undefined;
  });

const rowSchema = z.object({
  day: text,
  time: text,
  name: text,
  phone: text,
  code: text,
  confidence: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => {
      const n = typeof v === 'string' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
    }),
});

const resultSchema = z.object({
  sheetId: text,
  rows: z.array(z.unknown()),
});

/** Accepts a parsed object or the model's text; throws `ReaderError('bad_output')`. */
export function parseResult(raw: unknown): ReadResult {
  const value = typeof raw === 'string' ? extractJson(raw) : raw;
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) throw new ReaderError('bad_output');
  const rows: ReadRow[] = [];
  for (const item of parsed.data.rows) {
    const row = rowSchema.safeParse(item);
    if (!row.success) continue;
    const { confidence, ...fields } = row.data;
    const present = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (Object.keys(present).length === 0) continue;
    rows.push({ ...present, confidence });
    if (rows.length === MAX_ROWS) break;
  }
  return parsed.data.sheetId ? { sheetId: parsed.data.sheetId, rows } : { rows };
}

function extractJson(textValue: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(textValue);
  const body = (fenced ? fenced[1]! : textValue).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ReaderError('bad_output');
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new ReaderError('bad_output');
  }
}
