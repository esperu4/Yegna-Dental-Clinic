/**
 * The backup file (PRD §17, ADR 0012): every table as JSON, gzip'd, then encrypted with AES-256-GCM
 * under the `BACKUP_KEY` secret (32 random bytes, base64; the Doctor keeps a printed copy).
 *
 * Layout: `YDB1` (4 bytes) · IV (12 bytes) · ciphertext + GCM tag. The header is bound to the
 * ciphertext as GCM additional data, so it cannot be changed without the tag check failing. Web APIs only (WebCrypto,
 * CompressionStream), so the Worker that makes backups and the Node restore script share this file.
 */

export const MAGIC = 'YDB1';
export const FORMAT_VERSION = 1;

export interface BackupData {
  format: typeof FORMAT_VERSION;
  /** Epoch ms when the export ran. */
  createdAt: number;
  /** Raw D1 rows (snake_case columns) per table. */
  tables: Record<string, Record<string, unknown>[]>;
}

export class BackupFormatError extends Error {
  override name = 'BackupFormatError';
}

/** The AES key from its base64 form; refuses anything but 32 bytes. */
export async function importKey(base64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(base64.trim()), (c) => c.charCodeAt(0));
  } catch {
    throw new BackupFormatError('key_not_base64');
  }
  if (raw.byteLength !== 32) throw new BackupFormatError('key_not_32_bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encodeBackup(data: BackupData, key: CryptoKey): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(data));
  const zipped = await pipe(json, new CompressionStream('gzip'));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = new TextEncoder().encode(MAGIC);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, zipped),
  );
  const file = new Uint8Array(4 + 12 + sealed.byteLength);
  file.set(new TextEncoder().encode(MAGIC), 0);
  file.set(iv, 4);
  file.set(sealed, 16);
  return file;
}

export async function decodeBackup(file: Uint8Array, key: CryptoKey): Promise<BackupData> {
  if (file.byteLength < 16 + 16 || new TextDecoder().decode(file.subarray(0, 4)) !== MAGIC) {
    throw new BackupFormatError('not_a_backup');
  }
  let zipped: Uint8Array;
  try {
    zipped = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: file.subarray(4, 16), additionalData: file.subarray(0, 4) },
        key,
        file.subarray(16),
      ),
    );
  } catch {
    // Wrong key or a damaged file: GCM refuses both.
    throw new BackupFormatError('wrong_key_or_damaged');
  }
  const data = JSON.parse(
    new TextDecoder().decode(await pipe(zipped, new DecompressionStream('gzip'))),
  ) as BackupData;
  if (data.format !== FORMAT_VERSION || typeof data.tables !== 'object' || data.tables === null) {
    throw new BackupFormatError('unknown_format');
  }
  return data;
}

/** `yegna-backup-<env>-2026-11-16.ydb` */
export const backupName = (environment: string, localDate: string) =>
  `yegna-backup-${environment}-${localDate}.ydb`;

/**
 * 1st-of-month backups are kept this many months. PRD §17 says "indefinitely"; erased patients
 * (ADR 0007) stay in them that long, so the clinic decides (ADR 0012). Infinity = forever.
 */
export const MONTHLY_KEEP_MONTHS = Number.POSITIVE_INFINITY;

/**
 * Which backups to delete (PRD §17): keep the newest `keep` nightly ones, and backups made on the
 * 1st of a month for `monthlyMonths` months; delete the rest. Dates are `YYYY-MM-DD` (clinic local,
 * Gregorian); `today` is the newest date considered.
 */
export function expiredBackups(
  files: { id: string; date: string }[],
  keep = 30,
  monthlyMonths = MONTHLY_KEEP_MONTHS,
  today = new Date().toISOString().slice(0, 10),
): string[] {
  const newestFirst = [...files].sort((a, b) => b.date.localeCompare(a.date));
  const [y, m] = today.split('-').map(Number) as [number, number];
  const monthsOld = (date: string) => {
    const [fy, fm] = date.split('-').map(Number) as [number, number];
    return (y - fy) * 12 + (m - fm);
  };
  return newestFirst
    .slice(keep)
    .filter((f) => !(f.date.endsWith('-01') && monthsOld(f.date) < monthlyMonths))
    .map((f) => f.id);
}
