// Starts the API for e2e tests on a fresh local D1: wipe, migrate, then `wrangler dev`.
import { rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const apiDir = join(import.meta.dirname, '..', '..', 'api');
const persist = join(import.meta.dirname, '..', '.e2e-state');
export const E2E_SETUP_CODE = 'e2e-setup-code-0123456789abcdef0123456789';

rmSync(persist, { recursive: true, force: true });
// On Windows the command runs through a shell, so a path with spaces must be quoted.
const q = (v) => (process.platform === 'win32' ? `"${v}"` : v);
const opts = {
  cwd: apiDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, CI: '1' },
};
const migrate = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', q(persist)],
  opts,
);
if (migrate.status !== 0) process.exit(migrate.status ?? 1);
const dev = spawn(
  'pnpm',
  [
    'exec',
    'wrangler',
    'dev',
    '--port',
    '8787',
    '--persist-to',
    q(persist),
    '--var',
    `SETUP_CODE:${E2E_SETUP_CODE}`,
  ],
  opts,
);
dev.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => dev.kill(sig));
