/**
 * The reader chain for this environment (ADR 0009): every free reader whose key or binding is
 * present, private ones first and Gemini free last. Model names are vars with defaults, so the
 * golden-set evaluation can change them without a code change.
 */
import {
  type AiBinding,
  type ReaderChain,
  type ScheduleReader,
  chatReader,
  geminiReader,
  mistralOcrReader,
  type ReadResult,
  workersAiReader,
} from '@yegna/ai';
import { sheetIdFor } from '@yegna/shared';
import { addDays, localDateOf, weekdayOf } from '@yegna/time';

export const DEFAULT_MODELS = {
  workersAi: '@cf/meta/llama-4-scout-17b-16e-instruct',
  groq: 'qwen/qwen3.8-27b',
  openRouter: 'openrouter/free',
  gemini: 'gemini-3-flash-preview',
} as const;

/**
 * What the local stub reads (local development and end-to-end tests only): next week's F sheet
 * with one row on Monday 4:00 ET.
 */
export function stubResult(now: number): ReadResult {
  let monday = addDays(localDateOf(now), 7);
  while (weekdayOf(monday) !== 1) monday = addDays(monday, -1);
  return {
    sheetId: sheetIdFor({ template: 'F', monday }),
    rows: [{ day: 'mon', time: '4:00', name: 'Stub Patient', phone: '0911000000', confidence: 0.9 }],
  };
}

export function readerChain(env: Env, now = Date.now()): ReaderChain {
  const primary: ScheduleReader[] = [];
  if (env.ENVIRONMENT === 'local' && env.IMPORT_STUB_READER === '1') {
    const result = stubResult(now);
    primary.push({ id: 'stub', read: async () => structuredClone(result) });
  }
  if (env.AI) {
    primary.push(
      workersAiReader({
        ai: env.AI as unknown as AiBinding,
        model: env.WORKERS_AI_MODEL ?? DEFAULT_MODELS.workersAi,
      }),
    );
  }
  if (env.MISTRAL_API_KEY) primary.push(mistralOcrReader({ apiKey: env.MISTRAL_API_KEY }));
  if (env.GROQ_API_KEY) {
    primary.push(
      chatReader({
        id: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: env.GROQ_API_KEY,
        model: env.GROQ_MODEL ?? DEFAULT_MODELS.groq,
        jsonMode: true,
      }),
    );
  }
  if (env.OPENROUTER_API_KEY) {
    primary.push(
      chatReader({
        id: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL ?? DEFAULT_MODELS.openRouter,
      }),
    );
  }
  const lastResort: ScheduleReader[] = [];
  if (env.GEMINI_API_KEY) {
    lastResort.push(
      geminiReader({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL ?? DEFAULT_MODELS.gemini }),
    );
  }
  return { primary, lastResort };
}
