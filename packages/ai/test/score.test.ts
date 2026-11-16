import { describe, expect, it } from 'vitest';
import { normalise, scorePage, summarise } from '../src/score.ts';
import type { ReadResult } from '../src/types.ts';

const golden: ReadResult = {
  sheetId: 'YD-F-2019-T03W2',
  rows: [
    { day: 'mon', time: '4:00', name: 'አበበ ከበደ', phone: '0911223344', code: 'CL', confidence: 1 },
    { day: 'tue', time: '3:30', name: 'Hana T', phone: '0922334455', confidence: 1 },
  ],
};

describe('normalise', () => {
  it('ignores what a reviewer would not fix', () => {
    expect(normalise('phone', '0911 22-33 44')).toBe('0911223344');
    expect(normalise('time', '4.0')).toBe('4:00');
    expect(normalise('time', '04:30')).toBe('4:30');
    expect(normalise('time', '4')).toBe('4:00');
    expect(normalise('day', 'Monday')).toBe('mon');
    expect(normalise('day', '07')).toBe('7');
    expect(normalise('code', ' cl ')).toBe('CL');
    expect(normalise('name', '  Hana   t ')).toBe('hana t');
    expect(normalise('name', '   ')).toBeUndefined();
  });
});

describe('scorePage', () => {
  it('a perfect read needs no corrections', () => {
    const s = scorePage(golden, structuredClone(golden));
    expect(s).toMatchObject({ sheetIdCorrect: true, corrections: 0, missed: 0, extra: 0 });
    expect(s.fields.phone).toEqual({ expected: 2, correct: 2 });
    expect(s.fields.code).toEqual({ expected: 1, correct: 1 });
  });

  it('counts a wrong field, a missed entry and an invented entry', () => {
    const answer: ReadResult = {
      sheetId: 'yd-f-2019-t03w2',
      rows: [
        { day: 'mon', time: '4:00', name: 'አበበ ከበደ', phone: '0911223345', code: 'CL', confidence: 0.8 },
        { day: 'sat', time: '9:00', name: 'Ghost', confidence: 0.2 },
      ],
    };
    const s = scorePage(golden, answer);
    expect(s.sheetIdCorrect).toBe(true);
    expect(s.missed).toBe(1);
    expect(s.extra).toBe(1);
    // 1 wrong phone + 4 fields of the missed row + 1 deletion
    expect(s.corrections).toBe(6);
  });

  it('a field invented on a real entry is a correction', () => {
    const answer = structuredClone(golden);
    answer.rows[1]!.code = 'EX';
    expect(scorePage(golden, answer).corrections).toBe(1);
  });

  it('pairs rows by slot even when their order differs', () => {
    const answer: ReadResult = { rows: [...golden.rows].reverse() };
    const s = scorePage(golden, answer);
    expect(s.corrections).toBe(0);
    expect(s.sheetIdCorrect).toBe(false);
  });
});

describe('summarise', () => {
  it('averages corrections and field accuracy over pages', () => {
    const perfect = scorePage(golden, structuredClone(golden));
    const empty = scorePage(golden, { rows: [] });
    const sum = summarise([perfect, empty]);
    expect(sum.pages).toBe(2);
    expect(sum.averageCorrections).toBe((0 + 9) / 2);
    expect(sum.fieldAccuracy.phone).toBe(0.5);
    expect(sum.sheetIdAccuracy).toBe(0.5);
    expect(summarise([]).averageCorrections).toBe(0);
  });
});
