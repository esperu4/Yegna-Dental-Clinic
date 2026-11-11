/**
 * Gemini (free tier) through the REST `generateContent` API. ADR 0009: always the LAST reader in
 * the chain, because free-tier input may be used by Google and read by human reviewers.
 */
import { type Fetch, postJson, toBase64 } from '../http.ts';
import { parseResult } from '../parse.ts';
import { buildPrompt } from '../prompt.ts';
import { type ReadResult, ReaderError, type ScheduleReader } from '../types.ts';

export function geminiReader(options: {
  apiKey: string | undefined;
  model: string;
  fetch?: Fetch;
}): ScheduleReader {
  return {
    id: `gemini:${options.model}`,
    async read(input, signal): Promise<ReadResult> {
      if (!options.apiKey) throw new ReaderError('not_configured');
      const response = (await postJson(
        options.fetch ?? fetch,
        `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent`,
        // The key goes in a header, never the URL (URLs end up in logs).
        { 'x-goog-api-key': options.apiKey },
        {
          contents: [
            {
              role: 'user',
              parts: [
                { text: buildPrompt(input) },
                { inline_data: { mime_type: input.mime, data: toBase64(input.image) } },
              ],
            },
          ],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        },
        signal,
      )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] } | null;
      const textOut = response?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
      if (!textOut) throw new ReaderError('empty');
      return parseResult(textOut);
    },
  };
}
