/**
 * Scores a reader's answer against a golden page (PRD §12, §20 M4: "average < 3 corrections per
 * page"). A correction is one field a human would have to fix on the review screen: a wrong or
 * missing field on a matched row, every field of an entry the reader missed, and deleting an
 * entry the reader invented.
 */
import type { ReadResult, ReadRow } from './types.ts';

export const FIELDS = ['day', 'time', 'name', 'phone', 'code'] as const;
export type Field = (typeof FIELDS)[number];

export interface FieldTally {
  /** Fields present on the golden rows. */
  expected: number;
  /** Of those, read exactly (after normalising). */
  correct: number;
}

export interface PageScore {
  sheetIdCorrect: boolean;
  corrections: number;
  /** Golden entries with no matching row in the answer. */
  missed: number;
  /** Rows in the answer that match no golden entry. */
  extra: number;
  fields: Record<Field, FieldTally>;
}

/** Comparison form: case, spaces and punctuation that a reviewer would not fix are ignored. */
export function normalise(field: Field, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === '') return undefined;
  switch (field) {
    case 'phone':
      return v.replace(/\D/g, '');
    case 'time': {
      const m = /^(\d{1,2})\s*[:.]\s*(\d{1,2})$/.exec(v) ?? /^(\d{1,2})$/.exec(v);
      if (!m) return v;
      return `${Number(m[1])}:${(m[2] ?? '0').padStart(2, '0')}`;
    }
    case 'day':
      return /^\d+$/.test(v) ? String(Number(v)) : v.toLowerCase().slice(0, 3);
    case 'code':
      return v.toUpperCase().replace(/\s/g, '');
    case 'name':
      return v.replace(/\s+/g, ' ').toLowerCase();
  }
}

function same(field: Field, a: ReadRow, b: ReadRow): boolean {
  return normalise(field, a[field]) === normalise(field, b[field]);
}

/** How alike two rows are, for pairing: the slot counts most, then the phone, then the name. */
function affinity(golden: ReadRow, read: ReadRow): number {
  let score = 0;
  if (same('day', golden, read) && normalise('day', golden.day) !== undefined) score += 4;
  if (same('time', golden, read) && normalise('time', golden.time) !== undefined) score += 4;
  if (same('phone', golden, read) && normalise('phone', golden.phone) !== undefined) score += 3;
  if (same('name', golden, read) && normalise('name', golden.name) !== undefined) score += 3;
  return score;
}

export function scorePage(golden: ReadResult, answer: ReadResult): PageScore {
  const fields = Object.fromEntries(FIELDS.map((f) => [f, { expected: 0, correct: 0 }])) as Record<
    Field,
    FieldTally
  >;
  // Greedy pairing, best pairs first: a pair needs at least the day or the time plus one more
  // field to agree, otherwise the read row is an invented entry and the golden one was missed.
  const pairs: { g: number; r: number; score: number }[] = [];
  golden.rows.forEach((g, gi) =>
    answer.rows.forEach((r, ri) => {
      const score = affinity(g, r);
      if (score >= 7) pairs.push({ g: gi, r: ri, score });
    }),
  );
  pairs.sort((a, b) => b.score - a.score || a.g - b.g || a.r - b.r);
  const goldenUsed = new Map<number, number>();
  const readUsed = new Set<number>();
  for (const p of pairs) {
    if (goldenUsed.has(p.g) || readUsed.has(p.r)) continue;
    goldenUsed.set(p.g, p.r);
    readUsed.add(p.r);
  }

  let corrections = 0;
  golden.rows.forEach((g, gi) => {
    const ri = goldenUsed.get(gi);
    const r = ri === undefined ? undefined : answer.rows[ri];
    for (const f of FIELDS) {
      const want = normalise(f, g[f]);
      const got = r ? normalise(f, r[f]) : undefined;
      if (want !== undefined) {
        fields[f].expected++;
        if (got === want) fields[f].correct++;
        else corrections++;
      } else if (got !== undefined) {
        corrections++; // a field invented on a real entry must be cleared
      }
    }
  });
  const extra = answer.rows.length - readUsed.size;
  corrections += extra; // one tap to delete each invented entry

  return {
    sheetIdCorrect: (golden.sheetId ?? '') === (answer.sheetId ?? '').trim().toUpperCase(),
    corrections,
    missed: golden.rows.length - goldenUsed.size,
    extra,
    fields,
  };
}

export interface EvalSummary {
  pages: number;
  averageCorrections: number;
  sheetIdAccuracy: number;
  /** Per field: correct / expected over all pages (1 when nothing was expected). */
  fieldAccuracy: Record<Field, number>;
}

export function summarise(scores: PageScore[]): EvalSummary {
  const total = Object.fromEntries(FIELDS.map((f) => [f, { expected: 0, correct: 0 }])) as Record<
    Field,
    FieldTally
  >;
  for (const s of scores)
    for (const f of FIELDS) {
      total[f].expected += s.fields[f].expected;
      total[f].correct += s.fields[f].correct;
    }
  const n = scores.length;
  return {
    pages: n,
    averageCorrections: n ? scores.reduce((a, s) => a + s.corrections, 0) / n : 0,
    sheetIdAccuracy: n ? scores.filter((s) => s.sheetIdCorrect).length / n : 0,
    fieldAccuracy: Object.fromEntries(
      FIELDS.map((f) => [f, total[f].expected ? total[f].correct / total[f].expected : 1]),
    ) as Record<Field, number>,
  };
}
