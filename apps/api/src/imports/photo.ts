/**
 * Photos stay on Telegram (PRD §12): we keep the `file_id` only and fetch the bytes when reading
 * or showing an import. The bot token is part of Telegram's file URLs, so these URLs are never
 * logged or returned to clients.
 */

/**
 * Larger files are refused: the private readers can't take them, so they would reach only the
 * last-resort reader (privacy review 2026-11-11). Telegram's compressed photos are far smaller.
 */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** The image types we read and serve; anything else (e.g. SVG, which can carry scripts) is not. */
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export class PhotoUnavailable extends Error {
  constructor(readonly reason: 'not_configured' | 'not_found' | 'too_large' | 'http') {
    super(reason);
    this.name = 'PhotoUnavailable';
  }
}

export async function telegramPhoto(
  env: Env,
  fileId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ image: ArrayBuffer; mime: string }> {
  const token = env.TEAM_BOT_TOKEN;
  if (!token) throw new PhotoUnavailable('not_configured');
  const info = await fetchImpl(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  if (!info.ok) throw new PhotoUnavailable(info.status === 400 ? 'not_found' : 'http');
  const body = (await info.json()) as { result?: { file_path?: string; file_size?: number } };
  const path = body.result?.file_path;
  if (!path) throw new PhotoUnavailable('not_found');
  if ((body.result?.file_size ?? 0) > MAX_PHOTO_BYTES) throw new PhotoUnavailable('too_large');
  const file = await fetchImpl(`https://api.telegram.org/file/bot${token}/${path}`);
  if (!file.ok) throw new PhotoUnavailable('http');
  const image = await file.arrayBuffer();
  if (image.byteLength > MAX_PHOTO_BYTES) throw new PhotoUnavailable('too_large');
  return { image, mime: mimeOf(path, file.headers.get('content-type')) };
}

function mimeOf(path: string, header: string | null): string {
  const type = header?.split(';')[0]!.trim();
  if (type && (PHOTO_TYPES as readonly string[]).includes(type)) return type;
  if (/\.png$/i.test(path)) return 'image/png';
  if (/\.webp$/i.test(path)) return 'image/webp';
  return 'image/jpeg';
}

/** True when the bytes start like a JPEG, PNG or WebP file (not just the declared type). */
export function looksLikePhoto(bytes: Uint8Array): boolean {
  const at = (i: number) => bytes[i] ?? -1;
  const jpeg = at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
  const png = at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47;
  const webp =
    String.fromCharCode(at(0), at(1), at(2), at(3)) === 'RIFF' &&
    String.fromCharCode(at(8), at(9), at(10), at(11)) === 'WEBP';
  return jpeg || png || webp;
}
