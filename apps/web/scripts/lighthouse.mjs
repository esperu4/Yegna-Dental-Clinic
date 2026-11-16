/**
 * `pnpm --filter @yegna/web lighthouse`: builds the site as the real domain would serve it
 * (PUBLIC_INDEXABLE=1: no noindex, open robots.txt), runs Lighthouse CI on every page with
 * lighthouserc.json, then rebuilds the normal (noindex) site so dist/ is never left indexable.
 * CHROME_PATH picks the browser (CI: the runner's Chrome).
 *
 * lighthouserc.json: Lighthouse's defaults (mobile, simulated Slow 4G); every page (not Lighthouse
 * CI's default of five); 3 runs a page, assertions on the best run so one noisy run on a busy
 * runner does not fail the gate; >= 0.9 in all four categories, except SEO on the 404 page, which
 * is noindex on purpose.
 */
import { execSync } from 'node:child_process';

const run = (cmd, env = {}) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });

let failed = false;
try {
  run('pnpm build', { PUBLIC_INDEXABLE: '1' });
  run('pnpm exec lhci autorun --config=lighthouserc.json');
} catch {
  failed = true;
} finally {
  try {
    run('node scripts/lighthouse-summary.mjs');
  } catch {
    // No reports (the build failed): nothing to summarise.
  }
  run('pnpm build', { PUBLIC_INDEXABLE: '' });
}
if (failed) process.exit(1);
