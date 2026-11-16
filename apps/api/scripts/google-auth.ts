/**
 * One-time Google sign-in for the nightly backup (docs/runbooks/backups.md):
 *   pnpm google-auth --env staging   (asks for the client ID and secret, hidden)
 * Opens Google's consent page for the clinic account (scope `drive.file` only), receives the code
 * on a local loopback address, and stores the refresh token with `wrangler secret put` through
 * standard input, so the token is never shown, typed or saved to a file.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { secret } from './prompt.ts';

const { values } = parseArgs({ options: { env: { type: 'string' } } });
const environment = values.env;
if (environment !== 'staging' && environment !== 'production') {
  throw new Error('usage: pnpm google-auth --env <staging|production>');
}
const clientId = await secret('GOOGLE_CLIENT_ID', 'Google OAuth client ID');
const clientSecret = await secret('GOOGLE_CLIENT_SECRET', 'Google OAuth client secret');
// PKCE (S256): the code is useless to anyone who did not start this sign-in.
const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const challenge = Buffer.from(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
).toString('base64url');

const API_DIR = join(import.meta.dirname, '..');
const WRANGLER = join(
  dirname(createRequire(join(API_DIR, 'package.json')).resolve('wrangler/package.json')),
  'bin',
  'wrangler.js',
);
const state = crypto.randomUUID();

const server = createServer();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const redirectUri = `http://127.0.0.1:${port}`;

const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
consent.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/drive.file',
  access_type: 'offline',
  prompt: 'consent',
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
}).toString();
console.log('Open this address, sign in with the CLINIC Google account and allow access:\n');
console.log(consent.toString(), '\n');

const code = await new Promise<string>((resolve, reject) => {
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', redirectUri);
    const got = url.searchParams.get('code');
    if (url.searchParams.get('state') !== state || !got) {
      res.writeHead(400).end('Sign-in failed. Close this tab and run the command again.');
      reject(new Error(`sign-in failed: ${url.searchParams.get('error') ?? 'no code'}`));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Done. You can close this tab.');
    resolve(got);
  });
});
server.close();

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  }),
});
if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
const { refresh_token: refreshToken } = (await res.json()) as { refresh_token?: string };
if (!refreshToken)
  throw new Error(
    'Google returned no refresh token: remove the app’s access in the Google account and retry.',
  );

execFileSync(process.execPath, [WRANGLER, 'secret', 'put', 'GOOGLE_REFRESH_TOKEN', '--env', environment], {
  cwd: API_DIR,
  input: refreshToken,
  stdio: ['pipe', 'inherit', 'inherit'],
});
console.log(`Stored GOOGLE_REFRESH_TOKEN for ${environment}.`);
