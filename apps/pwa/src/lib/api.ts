/** Thin client for the Yegna API. Never logs request bodies (they may hold names or phones). */
import type { ApiErrorCode } from '@yegna/shared/client';

declare const __API_URL__: string;
export const API_URL: string = typeof __API_URL__ === 'string' ? __API_URL__ : 'http://localhost:8787';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'offline' | 'server_error',
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  /** A raw body (an uploaded photo) instead of JSON. */
  raw?: Blob;
  /** Read the answer as a file (a photo) instead of JSON. */
  as?: 'json' | 'blob';
  token?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** A request that hangs (weak signal, captive portal) is given up after this and treated as offline. */
export const REQUEST_TIMEOUT_MS = 30_000;

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.raw) headers['Content-Type'] = opts.raw.type;
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(`${API_URL}${path}`, {
        method: opts.method ?? (opts.body === undefined && !opts.raw ? 'GET' : 'POST'),
        headers,
        signal: controller.signal,
        ...(opts.raw
          ? { body: opts.raw }
          : opts.body !== undefined
            ? { body: JSON.stringify(opts.body) }
            : {}),
      });
    } catch {
      throw new ApiError(0, 'offline');
    }
    if (opts.as === 'blob' && res.ok) {
      try {
        return (await res.blob()) as T;
      } catch {
        throw new ApiError(0, 'offline');
      }
    }
    let data: { error?: ApiErrorCode; retryAfterMs?: number };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      // An unreadable body (cut off, or an HTML error page from a proxy) is never taken as success.
      throw new ApiError(res.ok ? 0 : res.status, res.ok ? 'offline' : 'server_error');
    }
    if (!res.ok) throw new ApiError(res.status, data.error ?? 'server_error', data.retryAfterMs);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}
