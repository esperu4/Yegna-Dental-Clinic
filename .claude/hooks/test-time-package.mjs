// PostToolUse hook: after an edit inside packages/time, run that package's tests.
// Failures are returned to Claude (exit 2) so it fixes them right away.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const filePath = input?.tool_input?.file_path;
if (!filePath) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const rel = path.relative(projectDir, path.resolve(projectDir, filePath)).split(path.sep).join('/');
if (!rel.startsWith('packages/time/')) process.exit(0);

const pkgDir = path.join(projectDir, 'packages', 'time');
// Not scaffolded yet, or dependencies not installed: nothing to run.
if (!existsSync(path.join(pkgDir, 'package.json')) || !existsSync(path.join(projectDir, 'node_modules'))) {
  process.exit(0);
}

const res = spawnSync('pnpm', ['--dir', pkgDir, 'exec', 'vitest', 'run', '--reporter=dot'], {
  cwd: projectDir,
  encoding: 'utf8',
  shell: process.platform === 'win32',
  timeout: 110_000,
});

if (res.status !== 0) {
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split('\n').slice(-60).join('\n');
  process.stderr.write(`packages/time tests failed after editing ${rel}:\n${out}\n`);
  process.exit(2);
}
process.exit(0);
