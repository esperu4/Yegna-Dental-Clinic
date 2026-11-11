/**
 * Tries readers in order until one returns usable rows (ADR 0009). `lastResort` readers (Gemini
 * free) run only after every private reader failed, so a photo reaches them only then. Each
 * attempt records the reader id and an error kind, never content.
 */
import {
  type ReadInput,
  type ReadResult,
  ReaderError,
  type ReaderErrorKind,
  type ScheduleReader,
} from './types.ts';

export interface ReaderChain {
  /** Readers that keep photos private, best first. */
  primary: ScheduleReader[];
  /** Readers whose terms allow the provider to use the photos; tried only after all of `primary`. */
  lastResort: ScheduleReader[];
}

export interface Attempt {
  readerId: string;
  outcome: 'ok' | ReaderErrorKind;
}

export type ChainOutcome =
  | { ok: true; readerId: string; result: ReadResult; attempts: Attempt[] }
  | { ok: false; attempts: Attempt[] };

export interface ChainOptions {
  /** Per-reader time limit. */
  timeoutMs?: number;
  /** Stops the whole chain (e.g. the request's own deadline). */
  signal?: AbortSignal;
}

export const DEFAULT_READER_TIMEOUT_MS = 25_000;

export async function readSchedule(
  chain: ReaderChain,
  input: ReadInput,
  options: ChainOptions = {},
): Promise<ChainOutcome> {
  const attempts: Attempt[] = [];
  for (const reader of [...chain.primary, ...chain.lastResort]) {
    if (options.signal?.aborted) break;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_READER_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const result = await reader.read(input, signal);
      if (result.rows.length === 0) {
        attempts.push({ readerId: reader.id, outcome: 'empty' });
        continue;
      }
      attempts.push({ readerId: reader.id, outcome: 'ok' });
      return { ok: true, readerId: reader.id, result, attempts };
    } catch (err) {
      const kind: ReaderErrorKind =
        err instanceof ReaderError ? err.kind : signal.aborted ? 'timeout' : 'http';
      attempts.push({ readerId: reader.id, outcome: kind });
    }
  }
  return { ok: false, attempts };
}
