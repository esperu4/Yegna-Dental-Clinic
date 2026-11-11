import { describe, expect, it } from 'vitest';
import { type ReadInput, ReaderError, type ScheduleReader, readSchedule, stubReader } from '../src/index.ts';

const input: ReadInput = {
  image: new ArrayBuffer(4),
  mime: 'image/jpeg',
  template: 'C',
  procedures: [],
  locale: 'en',
};
const ROWS = { rows: [{ name: 'Abebe', confidence: 0.9 }] };

/** A reader that records whether it was called, then fails or answers. */
function spy(id: string, behaviour: 'ok' | 'empty' | ReaderError | Error | 'hang') {
  const reader = {
    id,
    calls: 0,
    async read(_input: ReadInput, signal?: AbortSignal) {
      reader.calls++;
      if (behaviour === 'ok') return ROWS;
      if (behaviour === 'empty') return { rows: [] };
      if (behaviour === 'hang') {
        return new Promise<never>((_, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      }
      throw behaviour;
    },
  };
  return reader satisfies ScheduleReader;
}

describe('readSchedule (ADR 0009 fallbacks)', () => {
  it('uses the first reader that returns rows and stops there', async () => {
    const a = spy('a', new ReaderError('not_configured'));
    const b = spy('b', 'ok');
    const gemini = spy('gemini', 'ok');
    const out = await readSchedule({ primary: [a, b], lastResort: [gemini] }, input);
    expect(out).toEqual({
      ok: true,
      readerId: 'b',
      result: ROWS,
      attempts: [
        { readerId: 'a', outcome: 'not_configured' },
        { readerId: 'b', outcome: 'ok' },
      ],
    });
    expect(gemini.calls).toBe(0);
  });

  it('sends the photo to a last-resort reader only after every private reader failed', async () => {
    const order: string[] = [];
    const track = (r: ReturnType<typeof spy>) => ({
      id: r.id,
      read: (i: ReadInput, s?: AbortSignal) => {
        order.push(r.id);
        return r.read(i, s);
      },
    });
    const out = await readSchedule(
      {
        primary: [
          track(spy('workers-ai', new ReaderError('rate_limited'))),
          track(spy('mistral', 'empty')),
          track(spy('groq', new Error('boom'))),
        ],
        lastResort: [track(spy('gemini', 'ok'))],
      },
      input,
    );
    expect(order).toEqual(['workers-ai', 'mistral', 'groq', 'gemini']);
    expect(out.ok && out.readerId).toBe('gemini');
    expect(out.attempts.map((a) => a.outcome)).toEqual(['rate_limited', 'empty', 'http', 'ok']);
  });

  it('gives up a reader that takes too long and moves on', async () => {
    const out = await readSchedule(
      { primary: [spy('slow', 'hang'), stubReader(ROWS)], lastResort: [] },
      input,
      {
        timeoutMs: 20,
      },
    );
    expect(out.ok && out.readerId).toBe('stub');
    expect(out.attempts[0]).toEqual({ readerId: 'slow', outcome: 'timeout' });
  });

  it('reports failure (manual entry) when nothing could read the sheet, and stops on abort', async () => {
    const out = await readSchedule({ primary: [stubReader()], lastResort: [] }, input);
    expect(out).toEqual({ ok: false, attempts: [{ readerId: 'stub', outcome: 'empty' }] });
    const controller = new AbortController();
    controller.abort();
    const never = spy('never', 'ok');
    expect(
      await readSchedule({ primary: [never], lastResort: [] }, input, { signal: controller.signal }),
    ).toEqual({
      ok: false,
      attempts: [],
    });
    expect(never.calls).toBe(0);
  });

  it('the stub returns a fresh copy each time', async () => {
    const stub = stubReader(ROWS);
    const first = await stub.read(input);
    first.rows.push({ confidence: 0 });
    expect(await stub.read(input)).toEqual(ROWS);
  });
});
