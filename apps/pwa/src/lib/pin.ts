/**
 * The offline lock screen's own PIN verifier (PRD §8 item 1). It is computed on this device with a
 * device-only salt; the server's PIN hash never leaves the server.
 */
const ITERATIONS = 50_000;
const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PinVerifier {
  salt: string;
  hash: string;
  iterations: number;
}

async function derive(pin: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations },
    key,
    256,
  );
  return hex(new Uint8Array(bits));
}

export async function makeVerifier(pin: string): Promise<PinVerifier> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await derive(pin, salt, ITERATIONS), iterations: ITERATIONS };
}

export async function checkVerifier(pin: string, v: PinVerifier): Promise<boolean> {
  const got = await derive(pin, v.salt, v.iterations);
  let diff = got.length ^ v.hash.length;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ (v.hash.charCodeAt(i) || 0);
  return diff === 0;
}
