/**
 * Mistral OCR (`POST /v1/ocr`) with a document annotation: the OCR model reads the page and fills
 * the result schema in one call. The clinic must turn off training in Mistral's Admin Console
 * (ADR 0009).
 */
import { type Fetch, dataUrl, postJson } from '../http.ts';
import { parseResult } from '../parse.ts';
import { RESULT_SCHEMA, buildPrompt } from '../prompt.ts';
import { type ReadResult, ReaderError, type ScheduleReader } from '../types.ts';

export function mistralOcrReader(options: {
  apiKey: string | undefined;
  model?: string;
  fetch?: Fetch;
}): ScheduleReader {
  const model = options.model ?? 'mistral-ocr-latest';
  return {
    id: `mistral-ocr:${model}`,
    async read(input, signal): Promise<ReadResult> {
      if (!options.apiKey) throw new ReaderError('not_configured');
      const response = (await postJson(
        options.fetch ?? fetch,
        'https://api.mistral.ai/v1/ocr',
        { Authorization: `Bearer ${options.apiKey}` },
        {
          model,
          document: { type: 'image_url', image_url: dataUrl(input.image, input.mime) },
          document_annotation_format: {
            type: 'json_schema',
            json_schema: { name: 'schedule_sheet', schema: RESULT_SCHEMA, strict: true },
          },
          document_annotation_prompt: buildPrompt(input),
        },
        signal,
      )) as { document_annotation?: string | null } | null;
      if (!response?.document_annotation) throw new ReaderError('empty');
      return parseResult(response.document_annotation);
    },
  };
}
