/**
 * Prints each page's four Lighthouse scores and the audits below 0.9, from the reports Lighthouse
 * CI wrote to `.lighthouseci/` (`pnpm lighthouse` runs it at the end).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', '.lighthouseci');
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];

console.log(`${'page'.padEnd(28)} perf a11y best seo`);
for (const file of readdirSync(DIR).filter((f) => f.startsWith('lhr-') && f.endsWith('.json'))) {
  const lhr = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  const scores = CATEGORIES.map((k) => String(Math.round(lhr.categories[k].score * 100)).padStart(4));
  console.log(`${new URL(lhr.finalDisplayedUrl).pathname.padEnd(28)} ${scores.join(' ')}`);
  for (const k of CATEGORIES) {
    for (const ref of lhr.categories[k].auditRefs) {
      const audit = lhr.audits[ref.id];
      if (ref.weight > 0 && audit.score !== null && audit.score < 0.9) {
        console.log(`    ${k}: ${ref.id} (${audit.score}) ${audit.displayValue ?? ''}`);
      }
    }
  }
}
