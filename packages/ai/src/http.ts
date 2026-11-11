/** Shared plumbing for HTTP readers: base64 images and error mapping (no content in errors). */
import { ReaderError } from './types.ts';

export type Fetch = typeof fetch;

export function toBase64(image: ArrayBuffer): string {
  const bytes = new Uint8Array(image);
  let binary = '';
  // Chunks keep String.fromCharCode under the engine's argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function dataUrl(image: ArrayBuffer, mime: string): string {
  return `data:${mime};base64,${toBase64(image)}`;
}

/** POSTs JSON; maps failures to `ReaderError` kinds so the chain can move on. */
export async function postJson(
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw abortOr(err, signal);
  }
  if (res.status === 429) throw new ReaderError('rate_limited', 429);
  if (res.status === 401 || res.status === 403) throw new ReaderError('not_configured', res.status);
  if (!res.ok) throw new ReaderError('http', res.status);
  try {
    return await res.json();
  } catch {
    if (signal?.aborted) throw new ReaderError('timeout');
    throw new ReaderError('bad_output');
  }
}

export function abortOr(err: unknown, signal?: AbortSignal): ReaderError {
  if (err instanceof ReaderError) return err;
  return new ReaderError(signal?.aborted ? 'timeout' : 'http');
}
