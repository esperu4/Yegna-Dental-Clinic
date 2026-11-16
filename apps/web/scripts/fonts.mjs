/**
 * Self-hosted, subset fonts (PRD §15: Noto Sans Ethiopic + one Latin face, within 150 KB a page).
 * After `astro build`, collects every character the pages show and cuts each variable font down to
 * those glyphs, keeping the weight and width axes, into `dist/fonts/`. The full Ethiopic font is
 * ~330 KB; the subset is a small fraction of it. Text added later is covered by the next build.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import subsetFont from 'subset-font';

const DIST = join(import.meta.dirname, '..', 'dist');
const require = createRequire(import.meta.url);
const fontFile = (pkg, file) => join(dirname(require.resolve(`${pkg}/package.json`)), 'files', file);

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');

let text = '';
for (const page of walk(DIST).filter((p) => p.endsWith('.html'))) {
  const html = readFileSync(page, 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<head>[\s\S]*?<\/head>/, '');
  text += decode(html.replace(/<[^>]+>/g, ' '));
}
const chars = [...new Set(text)];
const ethiopic = chars.filter((c) => /[\u1200-\u139f\u2d80-\u2ddf\uab00-\uab2f]/u.test(c)).join('');
// Latin: what the pages use, plus basic punctuation and digits so small edits still render.
const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
const latin = [
  ...new Set(ascii + chars.filter((c) => /[\u00a0-\u024f\u2010-\u2027\u20ac]/u.test(c)).join('')),
].join('');

mkdirSync(join(DIST, 'fonts'), { recursive: true });
const jobs = [
  [
    'ethiopic.woff2',
    fontFile('@fontsource-variable/noto-sans-ethiopic', 'noto-sans-ethiopic-ethiopic-wdth-normal.woff2'),
    ethiopic + ' ፡።፣፤',
  ],
  [
    'latin.woff2',
    fontFile('@fontsource-variable/instrument-sans', 'instrument-sans-latin-wdth-normal.woff2'),
    latin,
  ],
];
for (const [name, source, glyphs] of jobs) {
  const out = await subsetFont(readFileSync(source), glyphs, { targetFormat: 'woff2' });
  writeFileSync(join(DIST, 'fonts', name), out);
  console.log(
    `fonts/${name.padEnd(14)} ${(out.byteLength / 1024).toFixed(1).padStart(6)} KB (${[...glyphs].length} characters)`,
  );
}
