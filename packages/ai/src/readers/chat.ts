/**
 * Readers for OpenAI-style chat APIs with image input (Groq, OpenRouter, Mistral vision chat) and
 * for Workers AI, which takes the same message shape through its binding.
 */
import { type Fetch, abortOr, dataUrl, postJson } from '../http.ts';
import { parseResult } from '../parse.ts';
import { buildPrompt } from '../prompt.ts';
import { type ReadInput, type ReadResult, ReaderError, type ScheduleReader } from '../types.ts';

function messages(input: ReadInput) {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: buildPrompt(input) },
        { type: 'image_url', image_url: { url: dataUrl(input.image, input.mime) } },
      ],
    },
  ];
}

/** The answer text (or object) of a chat completion, in the shapes the providers return. */
export function completionContent(response: unknown): unknown {
  const r = response as {
    choices?: { message?: { content?: unknown } }[];
    response?: unknown;
    result?: { response?: unknown };
  } | null;
  const content = r?.choices?.[0]?.message?.content ?? r?.response ?? r?.result?.response;
  if (content === undefined || content === null || content === '') throw new ReaderError('empty');
  return content;
}

export interface ChatReaderOptions {
  id: string;
  /** e.g. `https://api.groq.com/openai/v1` (the reader adds `/chat/completions`). */
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  /** Send `response_format: json_object` (not every provider accepts it with images). */
  jsonMode?: boolean;
  extraHeaders?: Record<string, string>;
  fetch?: Fetch;
}

export function chatReader(options: ChatReaderOptions): ScheduleReader {
  return {
    id: options.id,
    async read(input, signal): Promise<ReadResult> {
      if (!options.apiKey) throw new ReaderError('not_configured');
      const response = await postJson(
        options.fetch ?? fetch,
        `${options.baseUrl}/chat/completions`,
        { Authorization: `Bearer ${options.apiKey}`, ...options.extraHeaders },
        {
          model: options.model,
          messages: messages(input),
          temperature: 0,
          max_tokens: 4096,
          ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        },
        signal,
      );
      return parseResult(completionContent(response));
    },
  };
}

/** The part of the Workers AI binding a reader uses. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

export function workersAiReader(options: {
  id?: string;
  ai: AiBinding | undefined;
  model: string;
}): ScheduleReader {
  return {
    id: options.id ?? `workers-ai:${options.model}`,
    async read(input, signal): Promise<ReadResult> {
      if (!options.ai) throw new ReaderError('not_configured');
      let response: unknown;
      try {
        response = await options.ai.run(
          options.model,
          { messages: messages(input), max_tokens: 4096, temperature: 0 },
          signal ? { signal } : undefined,
        );
      } catch (err) {
        // The binding reports the daily free allocation as an error (code 4006).
        if (err instanceof Error && /4006|neuron|limit/i.test(err.message)) {
          throw new ReaderError('rate_limited');
        }
        throw abortOr(err, signal);
      }
      return parseResult(completionContent(response));
    },
  };
}
