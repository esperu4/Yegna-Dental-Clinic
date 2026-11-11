import { describe, expect, it } from 'vitest';
import { MAX_ROWS, ReaderError, buildPrompt, parseResult } from '../src/index.ts';

describe('parseResult', () => {
  it('keeps names exactly as written and drops blank fields', () => {
    const result = parseResult({
      sheetId: ' YD-F-2019-T03W2 ',
      rows: [
        { day: 'mon', time: '4:30', name: 'አበበ ከበደ', phone: '0911223344', code: 'CL', confidence: 0.9 },
        { day: 'tue', time: null, name: 'Hana T.', phone: '', code: 'null', confidence: '0.4' },
      ],
    });
    expect(result).toEqual({
      sheetId: 'YD-F-2019-T03W2',
      rows: [
        { day: 'mon', time: '4:30', name: 'አበበ ከበደ', phone: '0911223344', code: 'CL', confidence: 0.9 },
        { day: 'tue', name: 'Hana T.', confidence: 0.4 },
      ],
    });
  });

  it('reads JSON out of a fenced block or surrounding prose', () => {
    const fenced =
      'Here you go:\n```json\n{"sheetId": null, "rows": [{"name": "Abebe", "confidence": 1}]}\n```';
    expect(parseResult(fenced)).toEqual({ rows: [{ name: 'Abebe', confidence: 1 }] });
    expect(parseResult('{"rows": [{"time": 5, "confidence": 2}]}')).toEqual({
      rows: [{ time: '5', confidence: 1 }],
    });
  });

  it('drops empty and malformed rows, clamps confidence, caps the row count', () => {
    const result = parseResult({
      rows: [{ name: null, confidence: 0.5 }, 'junk', { name: 'A', confidence: -3 }, { name: 'B' }],
    });
    expect(result.rows).toEqual([
      { name: 'A', confidence: 0 },
      { name: 'B', confidence: 0 },
    ]);
    const many = parseResult({
      rows: Array.from({ length: 500 }, (_, i) => ({ name: `P${i}`, confidence: 1 })),
    });
    expect(many.rows).toHaveLength(MAX_ROWS);
  });

  it('refuses answers that are not the expected JSON', () => {
    for (const bad of ['no json here', '{"rows": "x"}', '{broken', { foo: 1 }, null]) {
      expect(() => parseResult(bad)).toThrow(ReaderError);
    }
  });
});

describe('buildPrompt', () => {
  it('names the template layout and the clinic’s procedure codes', () => {
    const prompt = buildPrompt({ template: 'O', procedures: [{ code: 'CL', name: 'Cleaning' }] });
    expect(prompt).toContain('Template O');
    expect(prompt).toContain('CL = Cleaning');
    expect(prompt).toContain('Never guess');
    expect(buildPrompt({ template: 'unknown', procedures: [] })).toContain('(none)');
  });
});
