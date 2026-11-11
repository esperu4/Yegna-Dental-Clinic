/**
 * A reader that returns fixed rows, for local development, tests and staging without keys
 * (PRD §20 M4: "a second stub provider").
 */
import type { ReadResult, ScheduleReader } from '../types.ts';

export function stubReader(result: ReadResult = { rows: [] }, id = 'stub'): ScheduleReader {
  return {
    id,
    async read() {
      return structuredClone(result);
    },
  };
}
