/**
 * PIN hashing and device tokens (PRD §18). WebCrypto only, so it runs on Workers and in Node.
 *
 * PIN hashes are PBKDF2-SHA256 with a per-user random salt, stored as
 * `pbkdf2-sha256$<iterations>$<hex>` so the cost can change without a migration.
 * A 4–6 digit PIN is weak however it is hashed; the real protection is the server-side
 * lockout (`rateLimit.ts`) and device revocation. The iteration count keeps CPU per request
 * low on the Workers free plan (PRD §19).
 */
export const PIN_HASH_ITERATIONS = 5_000;

const encoder = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomHex(byteLength: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input))));
}

async function pbkdf2(pin: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

export async function hashPin(pin: string): Promise<{ hash: string; salt: string }> {
  const salt = randomHex(16);
  return {
    hash: `pbkdf2-sha256$${PIN_HASH_ITERATIONS}$${await pbkdf2(pin, salt, PIN_HASH_ITERATIONS)}`,
    salt,
  };
}

export async function verifyPin(pin: string, stored: string, salt: string): Promise<boolean> {
  const [algo, iter, hex] = stored.split('$');
  const iterations = Number(iter);
  if (algo !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || iterations <= 0 || !hex) return false;
  return safeEqual(await pbkdf2(pin, salt, iterations), hex);
}

/** A new device token (sent once to the device) and the SHA-256 hash we store. */
export async function newDeviceToken(): Promise<{ token: string; tokenHash: string }> {
  const token = randomHex(32);
  return { token, tokenHash: await sha256Hex(token) };
}
