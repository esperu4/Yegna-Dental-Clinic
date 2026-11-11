import { describe, expect, it } from 'vitest';
import {
  type ReadInput,
  ReaderError,
  chatReader,
  geminiReader,
  mistralOcrReader,
  workersAiReader,
} from '../src/index.ts';

const input: ReadInput = {
  image: new Uint8Array([0xff, 0xd8, 0xff, 0x00]).buffer,
  mime: 'image/jpeg',
  template: 'F',
  procedures: [{ code: 'CL', name: 'Cleaning' }],
  locale: 'am',
};
const ANSWER = { sheetId: 'YD-F-2019-T03W2', rows: [{ name: 'አበበ', time: '4:00', confidence: 0.8 }] };

/** A fake fetch that records the request and answers with `status` and `body`. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls, body: () => JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown> };
}

describe('chat readers (Groq, OpenRouter, Mistral chat)', () => {
  const reader = (f: typeof fetch, apiKey: string | undefined = 'k') =>
    chatReader({
      id: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey,
      model: 'm',
      jsonMode: true,
      fetch: f,
    });
  const keyless = (f: typeof fetch) =>
    chatReader({ id: 'groq', baseUrl: 'https://x', apiKey: undefined, model: 'm', fetch: f });

  it('sends the prompt and the photo as a data URL, and parses the answer', async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: JSON.stringify(ANSWER) } }] });
    expect(await reader(f.impl).read(input)).toEqual(ANSWER);
    expect(f.calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const sent = JSON.stringify(f.body());
    expect(sent).toContain('data:image/jpeg;base64,/9j/AA==');
    expect(sent).toContain('Template F');
    expect(f.body().response_format).toEqual({ type: 'json_object' });
  });

  it('maps failures to error kinds the chain understands', async () => {
    const kind = async (status: number, body: unknown = {}) =>
      reader(fakeFetch(status, body).impl)
        .read(input)
        .catch((e: ReaderError) => e.kind);
    expect(await kind(429)).toBe('rate_limited');
    expect(await kind(401)).toBe('not_configured');
    expect(await kind(500)).toBe('http');
    expect(await kind(200, 'not json')).toBe('bad_output');
    expect(await kind(200, { choices: [{ message: { content: '' } }] })).toBe('empty');
    expect(await kind(200, { choices: [{ message: { content: 'sorry, cannot help' } }] })).toBe('bad_output');
    const missingKey = await keyless(fakeFetch(200, {}).impl)
      .read(input)
      .catch((e: ReaderError) => e.kind);
    expect(missingKey).toBe('not_configured');
  });

  it('reports a network failure as http and an abort as timeout', async () => {
    const failing = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    await expect(reader(failing).read(input)).rejects.toMatchObject({ kind: 'http' });
    const controller = new AbortController();
    controller.abort();
    await expect(reader(failing).read(input, controller.signal)).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('Workers AI reader', () => {
  it('runs the model through the binding and reads `response`', async () => {
    const runs: unknown[] = [];
    const ai = {
      async run(model: string, inputs: Record<string, unknown>) {
        runs.push({ model, inputs });
        return { response: JSON.stringify(ANSWER) };
      },
    };
    const reader = workersAiReader({ ai, model: '@cf/meta/llama-4-scout-17b-16e-instruct' });
    expect(reader.id).toBe('workers-ai:@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(await reader.read(input)).toEqual(ANSWER);
    expect(JSON.stringify(runs[0])).toContain('image_url');
  });

  it('accepts an already-parsed answer and reports the daily limit as rate_limited', async () => {
    const parsed = workersAiReader({ ai: { run: async () => ({ response: ANSWER }) }, model: 'm' });
    expect(await parsed.read(input)).toEqual(ANSWER);
    const limited = workersAiReader({
      ai: {
        run: async () => {
          throw new Error('4006: you have used up your daily free allocation of 10,000 neurons');
        },
      },
      model: 'm',
    });
    await expect(limited.read(input)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(workersAiReader({ ai: undefined, model: 'm' }).read(input)).rejects.toMatchObject({
      kind: 'not_configured',
    });
  });
});

describe('Gemini reader (last resort)', () => {
  it('sends the key in a header, never the URL, and parses the JSON text', async () => {
    const f = fakeFetch(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(ANSWER) }] } }] });
    const reader = geminiReader({ apiKey: 'secret', model: 'gemini-flash', fetch: f.impl });
    expect(await reader.read(input)).toEqual(ANSWER);
    expect(f.calls[0]!.url).not.toContain('secret');
    expect((f.calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret');
    expect(JSON.stringify(f.body())).toContain('"inline_data"');
    const empty = geminiReader({ apiKey: 'k', model: 'm', fetch: fakeFetch(200, { candidates: [] }).impl });
    await expect(empty.read(input)).rejects.toMatchObject({ kind: 'empty' });
  });
});

describe('Mistral OCR reader', () => {
  it('asks for a schema-shaped document annotation and parses it', async () => {
    const f = fakeFetch(200, { pages: [{ markdown: '…' }], document_annotation: JSON.stringify(ANSWER) });
    const reader = mistralOcrReader({ apiKey: 'k', fetch: f.impl });
    expect(await reader.read(input)).toEqual(ANSWER);
    expect(f.calls[0]!.url).toBe('https://api.mistral.ai/v1/ocr');
    const body = f.body();
    expect(body.model).toBe('mistral-ocr-latest');
    expect(body.document).toEqual({ type: 'image_url', image_url: 'data:image/jpeg;base64,/9j/AA==' });
    expect((body.document_annotation_format as { type: string }).type).toBe('json_schema');
    const none = mistralOcrReader({ apiKey: 'k', fetch: fakeFetch(200, { document_annotation: null }).impl });
    await expect(none.read(input)).rejects.toMatchObject({ kind: 'empty' });
    await expect(mistralOcrReader({ apiKey: undefined }).read(input)).rejects.toBeInstanceOf(ReaderError);
  });
});
