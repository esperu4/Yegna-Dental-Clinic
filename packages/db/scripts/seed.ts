// Writes the demo-clinic seed SQL. Usage: node scripts/seed.ts [out.sql]
import { writeFileSync } from 'node:fs';
import { buildSeedSql } from '../src/seed.ts';

const out = process.argv[2] ?? 'seed.sql';
writeFileSync(out, buildSeedSql());
console.warn(`Wrote ${out}`);
