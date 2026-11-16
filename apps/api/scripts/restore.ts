/**
 * `pnpm restore --from <file.ydb | drive:<file id>> --to <local|staging|production>` (PRD §17,
 * docs/runbooks/restore.md): decrypts a backup, checks it against the target database's schema,
 * replaces the target's contents, and compares row counts.
 *
 * Safety (privacy review M6):
 * - devices revoked and patients erased in the target since the backup stay revoked and erased;
 * - every phone is signed out (`--keep-devices` to skip, for rehearsals);
 * - production needs `--yes-replace-production`, and first prints a Time Travel bookmark to undo with.
 *
 * `BACKUP_KEY` (and, for `drive:` sources, the Google values) are asked for with hidden input
 * unless already set in the environment, so they never land in shell history. The SQL file holds
 * patient data in plain text: a private temp folder, deleted on exit, on Ctrl+C and at the next start.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { driveClient } from '../src/backup/drive.ts';
import { decodeBackup, importKey } from '../src/backup/format.ts';
import { afterRestoreStatements, restoreStatements, validateBackup } from '../src/backup/restoreSql.ts';
import { TARGETS, type Target, counts, query, schemaOf, timeTravelBookmark, wrangler } from './d1.ts';
import { secret } from './prompt.ts';

const TEMP_PREFIX = 'yegna-restore-';

/** Plain-text restore files left by an earlier run that was killed. */
function removeLeftovers() {
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith(TEMP_PREFIX)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      'yes-replace-production': { type: 'boolean' },
      'keep-devices': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });
  const target = values.to as Target;
  if (!values.from || !TARGETS.includes(target)) {
    throw new Error(
      'usage: pnpm restore --from <file.ydb|drive:<id>> --to <local|staging|production> [--dry-run] [--keep-devices]',
    );
  }
  if (target === 'production' && !values['yes-replace-production'] && !values['dry-run']) {
    throw new Error('Restoring into production replaces all its data: add --yes-replace-production.');
  }
  removeLeftovers();
  const key = await importKey(await secret('BACKUP_KEY', 'Backup key (the printed one)'));

  let file: Uint8Array;
  if (values.from.startsWith('drive:')) {
    file = await driveClient(
      {
        clientId: await secret('GOOGLE_CLIENT_ID', 'Google client ID'),
        clientSecret: await secret('GOOGLE_CLIENT_SECRET', 'Google client secret'),
        refreshToken: await secret('GOOGLE_REFRESH_TOKEN', 'Google refresh token'),
      },
      target === 'local' ? 'staging' : target,
    ).download(values.from.slice('drive:'.length));
  } else {
    file = new Uint8Array(readFileSync(values.from));
  }

  const data = await decodeBackup(file, key);
  console.log(`Backup made ${new Date(data.createdAt).toISOString()}`);
  const check = validateBackup(data, schemaOf(target));
  for (const [t, n] of Object.entries(check.counts)) console.log(`  ${t.padEnd(22)} ${n}`);
  if (!check.ok) {
    for (const p of check.problems) console.error(`✗ ${p}`);
    throw new Error(
      'The backup does not fit the target schema (run its migrations first?). Nothing changed.',
    );
  }

  // What the target knows that the backup may not: keep it.
  const revokedDevices = query<{ id: string; revoked_at: number }>(
    target,
    'SELECT id, revoked_at FROM devices WHERE revoked_at IS NOT NULL',
  ).map((d) => ({ id: d.id, revokedAt: d.revoked_at }));
  const erasedPatients = query<{ id: string }>(
    target,
    'SELECT id FROM patients WHERE deleted_at IS NOT NULL',
  ).map((p) => p.id);
  console.log(
    `Kept from the target: ${revokedDevices.length} revoked phones, ${erasedPatients.length} erased patients.`,
  );
  if (values['dry-run']) {
    console.log('Dry run: the backup is valid for the target. Nothing changed.');
    return;
  }
  if (target === 'production') {
    console.log(`Undo point (D1 Time Travel bookmark): ${timeTravelBookmark(target)}`);
    console.log('  To undo: npx wrangler d1 time-travel restore DB --env production --bookmark <it>');
  }

  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.once('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      cleanup();
      process.exit(130);
    });
  }
  try {
    const sqlFile = join(dir, 'restore.sql');
    const statements = [
      ...restoreStatements(data),
      ...afterRestoreStatements(
        { revokedDevices, erasedPatients },
        Date.now(),
        values['keep-devices'] === true,
      ),
    ];
    writeFileSync(sqlFile, `${statements.join(';\n')};\n`, { mode: 0o600 });
    wrangler(target, ['--yes', '--file', sqlFile]);
  } finally {
    cleanup();
  }

  const after = counts(target, Object.keys(data.tables));
  let ok = true;
  for (const [t, n] of Object.entries(check.counts)) {
    const mark = after[t] === n ? '✓' : '✗';
    if (after[t] !== n) ok = false;
    console.log(`${mark} ${t.padEnd(22)} backup ${n} · now ${after[t]}`);
  }
  if (!ok) throw new Error('Row counts differ after the restore: check the output above.');
  console.log(`Restored into ${target}.`);
  if (!values['keep-devices'])
    console.log('Every phone was signed out: each one must sign in again (runbook).');
  console.log('Now spot-check patients and bookings in the app (runbook §4).');
}

await main();
