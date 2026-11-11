/**
 * The schedule reader interface (PRD §12): reads a photo of a paper template into rows. Readers
 * are swappable and tried in order by `readSchedule` (ADR 0009: free readers only, Gemini last).
 */

export type TemplateCode = 'F' | 'C' | 'O' | 'unknown';

export interface ReadInput {
  image: ArrayBuffer;
  mime: string;
  template: TemplateCode;
  procedures: { code: string; name: string }[];
  locale: 'am' | 'en';
}

/** One handwritten entry. Every text field is as written on the sheet; unreadable ⇒ absent. */
export interface ReadRow {
  /** Weekday column (`mon`…`sat`) on F/C, or the day of the month on O. */
  day?: string;
  /** Ethiopian (ET) time as written, e.g. `4:30`. */
  time?: string;
  name?: string;
  phone?: string;
  code?: string;
  /** The reader's confidence in this row, 0–1. */
  confidence: number;
}

export interface ReadResult {
  sheetId?: string;
  rows: ReadRow[];
}

export interface ScheduleReader {
  /** Stable id, recorded on the import (`imports.provider`). */
  id: string;
  read(input: ReadInput, signal?: AbortSignal): Promise<ReadResult>;
}

/** Why a reader gave no result; the chain then tries the next reader. Never carries content. */
export type ReaderErrorKind = 'not_configured' | 'rate_limited' | 'timeout' | 'http' | 'bad_output' | 'empty';

export class ReaderError extends Error {
  constructor(
    readonly kind: ReaderErrorKind,
    readonly status?: number,
  ) {
    super(status ? `${kind} (${status})` : kind);
    this.name = 'ReaderError';
  }
}
