/**
 * Per-page budget (PRD §15, hard): 0 KB JavaScript, and at most 150 KB transferred per page,
 * counted as the gzip size of the HTML plus every local stylesheet, script, font and image it
 * loads. Also checks each page's SEO basics: one <h1>, title, description, canonical, hreflang.
 * Runs on `dist/` after `astro build`; exits 1 on any failure.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = join(import.meta.dirname, '..', 'dist');
const BUDGET = 150 * 1024;

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const gz = (path) => gzipSync(readFileSync(path)).byteLength;
const failures = [];
const pages = walk(DIST).filter((p) => p.endsWith('.html'));
if (pages.length === 0) failures.push('no pages in dist/ (run astro build first)');

for (const page of pages) {
  const name = `/${relative(DIST, page).replaceAll('\\', '/')}`;
  const html = readFileSync(page, 'utf8');
  const assets = new Set(
    [...html.matchAll(/(?:href|src)="(\/[^"#?]+\.(?:css|js|mjs|woff2?|svg|png|webp|avif|jpg))"/g)].map(
      (m) => m[1],
    ),
  );
  let total = gz(page);
  for (const asset of assets) total += gz(join(DIST, asset));

  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].filter(
    (m) => !/type="application\/ld\+json"/.test(m[1]),
  );
  if (scripts.length) failures.push(`${name}: ${scripts.length} script(s); the site ships no JavaScript`);
  if ([...assets].some((a) => /\.m?js$/.test(a))) failures.push(`${name}: loads a JavaScript file`);
  if (total > BUDGET) failures.push(`${name}: ${(total / 1024).toFixed(1)} KB > 150 KB`);

  if (!name.endsWith('/404.html')) {
    if ((html.match(/<h1\b/g) ?? []).length !== 1) failures.push(`${name}: needs exactly one <h1>`);
    for (const [label, re] of [
      ['title', /<title>[^<]+<\/title>/],
      ['description', /<meta name="description" content="[^"]+"/],
      ['canonical', /<link rel="canonical"/],
      ['hreflang am', /hreflang="am"/],
      ['hreflang en', /hreflang="en"/],
      ['hreflang x-default', /hreflang="x-default"/],
      ['Dentist JSON-LD', /"@type":"Dentist"/],
    ]) {
      if (!re.test(html)) failures.push(`${name}: missing ${label}`);
    }
  }
  console.log(`${name.padEnd(28)} ${(total / 1024).toFixed(1).padStart(6)} KB`);
}

for (const f of ['sitemap.xml', 'robots.txt']) {
  try {
    statSync(join(DIST, f));
  } catch {
    failures.push(`missing /${f}`);
  }
}

if (failures.length) {
  for (const f of failures) console.error(`✗ ${f}`);
  process.exit(1);
}
console.log(`✓ ${pages.length} pages within budget, no JavaScript`);
