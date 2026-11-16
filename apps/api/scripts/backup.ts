/**
 * `pnpm backup --from <local|staging|production> --out <file.ydb>`: the same encrypted file as the
 * nightly backup (ADR 0012), made by hand, e.g. before a risky change or to rehearse a restore.
 * Asks for the backup key (hidden), unless `BACKUP_KEY` is set. Write the file outside the repo. The file holds patient data (encrypted): keep it safe.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { FORMAT_VERSION, encodeBackup, importKey } from '../src/backup/format.ts';
import { TARGETS, type Target, query, schemaOf } from './d1.ts';
import { secret } from './prompt.ts';

const { values } = parseArgs({ options: { from: { type: 'string' }, out: { type: 'string' } } });
const target = values.from as Target;
if (!TARGETS.includes(target) || !values.out) {
  throw new Error('usage: pnpm backup --from <local|staging|production> --out <file.ydb>');
}
const key = await importKey(await secret('BACKUP_KEY', 'Backup key'));
const tables: Record<string, Record<string, unknown>[]> = {};
for (const table of Object.keys(schemaOf(target)).sort()) {
  tables[table] = query<Record<string, unknown>>(target, `SELECT * FROM "${table}"`);
  console.log(`  ${table.padEnd(22)} ${tables[table].length}`);
}
writeFileSync(
  values.out,
  await encodeBackup({ format: FORMAT_VERSION, createdAt: Date.now(), tables }, key),
  {
    mode: 0o600,
  },
);
console.log(`Wrote ${values.out}`);
