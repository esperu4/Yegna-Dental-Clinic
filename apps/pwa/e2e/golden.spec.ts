/**
 * Makes the import golden set (PRD §12: ≥ 10 sample sheets, all three templates, mixed scripts)
 * from the real print templates: fills them with handwriting-style entries, tilts and shades the
 * page like a phone photo, and saves `<case>.jpg` + `<case>.json` (the expected reading).
 * Skipped unless GOLDEN_OUT is set:
 *   GOLDEN_OUT=../../packages/ai/golden pnpm --filter @yegna/pwa e2e golden
 * The entries are synthetic (seeded), never real patients. Real photos can be added beside them.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { doctorPhone } from './helpers.ts';

const OUT = process.env.GOLDEN_OUT ? resolve(process.env.GOLDEN_OUT) : undefined;

const PROCEDURES = [
  { am: 'ማጽዳት', en: 'Cleaning', code: 'CL' },
  { am: 'መንቀል', en: 'Extraction', code: 'EX' },
  { am: 'መሙላት', en: 'Filling', code: 'FL' },
  { am: 'ምርመራ', en: 'Check-up', code: 'CH' },
];

const NAMES_AM = [
  'አበበ ከበደ',
  'ሐና ታደሰ',
  'መሰረት ዓለሙ',
  'ዮሐንስ ገብሩ',
  'ትዕግስት በቀለ',
  'ሰላም ኃይሌ',
  'ብርሃኑ ደስታ',
  'ፍቅርተ ወልዴ',
  'ዳዊት አሰፋ',
  'ማርታ ጌታቸው',
];
const NAMES_EN = [
  'Abebe K.',
  'Hana T.',
  'Meseret A.',
  'Yohannes G.',
  'Tigist B.',
  'Selam H.',
  'Biruk D.',
  'Liya W.',
  'Dawit A.',
  'Marta G.',
];

/** Small seeded PRNG (mulberry32) so a case is the same every time it is made. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case {
  name: string;
  template: 'F' | 'C' | 'O';
  locale: 'am' | 'en';
  seed: number;
  /** Entries to write per sheet. */
  entries: number;
  /** Share of names written in Ge'ez. */
  amharicNames: number;
  /** How far the "photo" is tilted (degrees). */
  tilt: number;
}

const CASES: Case[] = [
  { name: '01-F-en', template: 'F', locale: 'en', seed: 11, entries: 14, amharicNames: 0.3, tilt: 2 },
  { name: '02-F-en', template: 'F', locale: 'en', seed: 12, entries: 20, amharicNames: 0.5, tilt: -3 },
  { name: '03-F-am', template: 'F', locale: 'am', seed: 13, entries: 16, amharicNames: 0.9, tilt: 1.5 },
  { name: '04-F-am', template: 'F', locale: 'am', seed: 14, entries: 10, amharicNames: 0.7, tilt: -1 },
  { name: '05-C-en', template: 'C', locale: 'en', seed: 21, entries: 9, amharicNames: 0.4, tilt: 2.5 },
  { name: '06-C-am', template: 'C', locale: 'am', seed: 22, entries: 11, amharicNames: 0.8, tilt: -2 },
  { name: '07-O-en', template: 'O', locale: 'en', seed: 31, entries: 18, amharicNames: 0.4, tilt: 1 },
  { name: '08-O-am', template: 'O', locale: 'am', seed: 32, entries: 14, amharicNames: 0.9, tilt: -2.5 },
];

interface Entry {
  day: string;
  time: string;
  name: string;
  phone?: string;
  code?: string;
  confidence: number;
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Writes entries into the sheet's empty lines; returns each sheet's ID and its entries. */
async function fill(page: Page, c: Case): Promise<{ sheetId: string; rows: Entry[] }[]> {
  const r = rng(Math.imul(c.seed, 2654435761));
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const sheets = await page.locator('.paper').count();
  const result: { sheetId: string; rows: Entry[] }[] = [];
  for (let s = 0; s < sheets; s++) {
    const sheet = page.locator('.paper').nth(s);
    const sheetId = (await sheet.locator('.paper-id').textContent())!.trim();
    // Plan entries in node (seeded), then draw them in the page.
    const slots = await sheet.evaluate((el) => {
      if (el.classList.contains('paper-O')) {
        return [...el.querySelectorAll('td:not(.closed):not(.outside)')].map((td, i) => ({
          cell: i,
          day: td.querySelector('.day-no')!.textContent!.trim(),
          hour: '',
          lines: td.querySelectorAll('.month-line').length,
        }));
      }
      const out: { cell: number; day: string; hour: string; lines: number }[] = [];
      let cell = 0;
      el.querySelectorAll('tbody tr').forEach((tr) => {
        const hour = tr.querySelector('th')!.textContent!.match(/\d{1,2}:\d{2}/)?.[0] ?? '';
        tr.querySelectorAll('td').forEach((td, col) => {
          if (!td.classList.contains('closed') && !tr.classList.contains('lunch'))
            out.push({ cell, day: String(col), hour, lines: td.querySelectorAll('.entry').length });
          cell++;
        });
      });
      return out;
    });
    const isO = c.template === 'O';
    const firstDay = isO ? 0 : c.template === 'C' && s === 1 ? 3 : 0;
    const used = new Set<string>();
    const draws: { cell: number; line: number; minute: string; name: string; phone: string; code: string }[] =
      [];
    const rows: Entry[] = [];
    let guard = 0;
    while (rows.length < c.entries && guard++ < 1000) {
      const slot = pick(slots);
      const line = Math.floor(r() * slot.lines);
      const key = `${slot.cell}/${line}`;
      if (used.has(key)) continue;
      used.add(key);
      const name = r() < c.amharicNames ? pick(NAMES_AM) : pick(NAMES_EN);
      const minute = pick(['00', '00', '15', '30', '30', '45']);
      const hour = isO ? String(3 + Math.floor(r() * 9)) : slot.hour.split(':')[0]!;
      const phone = isO || r() < 0.15 ? '' : `09${String(Math.floor(r() * 1e8)).padStart(8, '0')}`;
      const code = isO || r() < 0.25 ? '' : pick(PROCEDURES).code;
      draws.push({ cell: slot.cell, line, minute, name, phone, code: code });
      rows.push({
        day: isO ? slot.day : WEEKDAYS[firstDay + Number(slot.day)]!,
        time: `${hour}:${minute}`,
        name,
        ...(phone ? { phone } : {}),
        ...(code ? { code } : {}),
        confidence: 1,
      });
      if (isO) draws.at(-1)!.minute = `${hour}:${minute}`;
    }
    const seedJitter = c.seed * 7 + s;
    await sheet.evaluate(
      (el, { draws, seedJitter }) => {
        let seed = seedJitter;
        const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        const hand = (node: Element, text: string, size: number) => {
          node.textContent = text;
          const h = node as HTMLElement;
          h.style.fontFamily = '"Caveat", "Noto Serif Ethiopic", "Nyala", "Ink Free", cursive';
          h.style.color = r() < 0.6 ? '#1d2a6b' : '#222';
          h.style.fontSize = `${size * (0.9 + r() * 0.25)}px`;
          h.style.display = 'inline-block';
          h.style.transform = `rotate(${(r() - 0.5) * 5}deg) translateY(${(r() - 0.5) * 2}px)`;
          h.style.whiteSpace = 'nowrap';
          h.style.overflow = 'visible';
        };
        const cells = el.classList.contains('paper-O')
          ? [...el.querySelectorAll('td:not(.closed):not(.outside)')]
          : [...el.querySelectorAll('tbody td')];
        for (const d of draws) {
          const td = cells[d.cell]!;
          if (el.classList.contains('paper-O')) {
            const line = td.querySelectorAll('.month-line')[d.line]!;
            hand(line.querySelector('.at')!, d.minute, 13);
            hand(line.querySelector('.name')!, d.name, 13);
            continue;
          }
          const entry = td.querySelectorAll('.entry')[d.line]!;
          hand(entry.querySelector('.minute')!, `:${d.minute}`, 13);
          hand(entry.querySelector('.name')!, d.name, /[ሀ-፿]/.test(d.name) ? 11 : 13);
          entry.querySelectorAll('.box').forEach((box, i) => {
            if (d.phone[i]) hand(box, d.phone[i]!, 12);
          });
          if (d.code) hand(entry.querySelector('.code')!, d.code, 12);
        }
      },
      { draws, seedJitter },
    );
    result.push({ sheetId, rows });
  }
  return result;
}

/**
 * Puts a copy of a sheet on a "desk" above the app, tilted and shaded like a phone photo of paper.
 * The copy keeps the screen's paper size (A4 landscape) whatever the app's layout width.
 */
async function photo(page: Page, sheet: number, tilt: number) {
  await page.evaluate(
    ({ sheet, tilt }) => {
      document.querySelectorAll('.golden-frame').forEach((f) => f.remove());
      const paper = document.querySelectorAll<HTMLElement>('.paper')[sheet]!.cloneNode(true) as HTMLElement;
      const frame = document.createElement('div');
      frame.className = 'golden-frame papers';
      frame.style.cssText =
        'position:absolute;top:0;left:0;z-index:9999;margin:0;padding:56px;width:max-content;' +
        'background:linear-gradient(135deg,#7a6a58,#5e5144);';
      frame.appendChild(paper);
      document.body.appendChild(frame);
      paper.style.margin = '0';
      paper.style.transform = `perspective(1800px) rotateX(${tilt * 1.2}deg) rotateZ(${tilt}deg)`;
      paper.style.boxShadow = '0 18px 40px rgba(0,0,0,.45)';
      paper.style.background = 'radial-gradient(ellipse at 30% 20%, #ffffff 0%, #f1efe8 60%, #dedad0 100%)';
      paper.style.filter = 'contrast(1.05) blur(0.35px)';
      window.scrollTo(0, 0);
    },
    { sheet, tilt },
  );
}

test('make the import golden set from the print templates', async ({ browser }) => {
  test.skip(!OUT, 'set GOLDEN_OUT to make the golden set');
  test.setTimeout(240_000);
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    deviceScaleFactor: 1.5,
  });
  const page = await context.newPage();
  await doctorPhone(page, 'Golden set phone');
  for (const p of PROCEDURES) {
    await page.goto('/#/procedures');
    await page.getByRole('button', { name: '+ Add procedure' }).click();
    await page.getByLabel('Name in Amharic').fill(p.am);
    await page.getByLabel('Name in English').fill(p.en);
    await page.getByLabel('Code (1–3 letters)').fill(p.code);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(p.en)).toBeVisible();
  }
  await mkdir(OUT!, { recursive: true });

  for (const c of CASES) {
    await page.goto('/#/print');
    const lang = page.locator('html');
    if ((await lang.getAttribute('lang')) !== c.locale) {
      await page
        .getByRole('button', { name: /switch language|ቋንቋ/i })
        .first()
        .click();
      await expect(lang).toHaveAttribute('lang', c.locale);
    }
    await page.locator('.segmented[role=group] button').nth(['F', 'C', 'O'].indexOf(c.template)).click();
    await expect(page.locator(`.paper-${c.template}`).first()).toBeVisible();
    await page.addStyleTag({
      content:
        '@import url("https://fonts.googleapis.com/css2?family=Caveat:wght@500&family=Noto+Serif+Ethiopic:wght@400&display=block");',
    });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const sheets = await fill(page, c);
    for (const [i, sheet] of sheets.entries()) {
      await photo(page, i, c.tilt * (i ? -1 : 1));
      const name = sheets.length > 1 ? `${c.name}${i + 1}` : c.name;
      await page
        .locator('.golden-frame')
        .screenshot({ path: join(OUT!, `${name}.jpg`), type: 'jpeg', quality: 72 });
      await page.evaluate(() => document.querySelectorAll('.golden-frame').forEach((f) => f.remove()));
      const golden = {
        image: `${name}.jpg`,
        mime: 'image/jpeg',
        template: c.template,
        locale: c.locale,
        procedures: PROCEDURES.map((p) => ({ code: p.code, name: c.locale === 'am' ? p.am : p.en })),
        expected: { sheetId: sheet.sheetId, rows: sheet.rows },
      };
      await writeFile(join(OUT!, `${name}.json`), `${JSON.stringify(golden, null, 2)}\n`);
    }
  }
  await context.close();
});
