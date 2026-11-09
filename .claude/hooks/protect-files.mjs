// PreToolUse hook: blocks edits to secrets, the lockfile, and already-existing migrations.
// Exit code 2 blocks the tool call and shows stderr to Claude.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const filePath = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
if (!filePath) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const rel = path.relative(projectDir, path.resolve(projectDir, filePath)).split(path.sep).join('/');
const base = path.posix.basename(rel);

const block = (msg) => {
  process.stderr.write(`Blocked by .claude/hooks/protect-files.mjs: ${msg}\n`);
  process.exit(2);
};

if (/^\.dev\.vars/.test(base) || (/^\.env/.test(base) && base !== '.env.example')) {
  block(`${rel} holds secrets (PRD §18). Ask the human to set it, or use \`wrangler secret put\`.`);
}

if (base === 'pnpm-lock.yaml') {
  block('pnpm-lock.yaml is generated. Change package.json and run `pnpm install` instead.');
}

if (/(^|\/)packages\/db\/migrations\//.test(rel) && existsSync(path.resolve(projectDir, rel))) {
  block(
    `${rel} is an existing migration and may already be applied to D1. ` +
      'Change the Drizzle schema and generate a new migration instead.',
  );
}

process.exit(0);
