/**
 * M4 paper templates (PRD §11, §20 "all 3 templates print correctly on A4 landscape"): each
 * template prints as A4 landscape PDF pages, one page per sheet, with the sheet ID on it.
 * Chromium's print-to-PDF is the same engine Android's "Save as PDF" uses.
 */
import { expect, test } from '@playwright/test';
import { doctorPhone } from './helpers.ts';

/** Pages in a PDF, with their size in points (A4 landscape ≈ 842 × 595). */
function pdfPages(pdf: Buffer): { width: number; height: number }[] {
  const text = pdf.toString('latin1');
  const pages = [
    ...text.matchAll(
      /\/Type\s*\/Page[^s][\s\S]*?\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g,
    ),
  ];
  return pages.map((m) => ({ width: Number(m[3]) - Number(m[1]), height: Number(m[4]) - Number(m[2]) }));
}

test('the three templates print on A4 landscape, one page per sheet (PRD §11)', async ({ page, browser }) => {
  await doctorPhone(page, 'Print test phone');
  await page.getByRole('button', { name: 'Print sheets' }).click();
  await expect(page.getByRole('heading', { name: 'Print paper sheets' })).toBeVisible();

  // Printing needs a procedure for the legend; add one if this clinic has none yet.
  if (await page.getByText('Add at least one procedure first').isVisible()) {
    await page.goto('/#/procedures');
    await page.getByRole('button', { name: '+ Add procedure' }).click();
    await page.getByLabel('Name in Amharic').fill('ማጽዳት');
    await page.getByLabel('Name in English').fill('Cleaning');
    await page.getByLabel('Code (1–3 letters)').fill('PR');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.goto('/#/print');
  }
  await expect(page.getByRole('button', { name: 'Print (A4 landscape)' })).toBeVisible();

  const expected = { 'Familiar (F)': 1, 'Clear (C)': 2, 'Overview (O)': 1 } as const;
  for (const [label, sheets] of Object.entries(expected)) {
    await page.getByRole('button', { name: label }).click();
    const ids = page.locator('.paper-id');
    await expect(ids).toHaveCount(sheets);
    await expect(ids.first()).toHaveText(/^YD-[FCO]-\d{4}-T\d{2}(W\d(-[12])?)?$/);
    await expect(page.locator('.qr svg')).toHaveCount(sheets);

    await page.emulateMedia({ media: 'print' });
    // Nothing on a sheet is cut off: the content fits the A4 page box (legend included).
    const overflow = await page
      .locator('.paper')
      .evaluateAll((sheets) => sheets.map((s) => ({ content: s.scrollHeight, box: s.clientHeight })));
    for (const o of overflow)
      expect(o.content, `${label}: sheet content fits the page`).toBeLessThanOrEqual(o.box);
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    await page.emulateMedia({ media: 'screen' });
    const pages = pdfPages(pdf);
    expect(pages, `${label}: one PDF page per sheet`).toHaveLength(sheets);
    for (const p of pages) {
      expect(p.width).toBeGreaterThan(p.height); // landscape
      expect(Math.round(p.width)).toBe(842); // A4
      expect(Math.round(p.height)).toBe(595);
    }
  }

  // The same sheets laid out by a desktop browser at the printed page size (phone emulation zooms
  // text): they must fit there too. PRINT_SHOTS=<dir> also saves each one for a human look.
  {
    const desktop = await browser.newContext({
      storageState: await page.context().storageState({ indexedDB: true }),
      viewport: { width: 1062, height: 733 },
    });
    const shot = await desktop.newPage();
    await shot.goto('/#/print');
    await shot.emulateMedia({ media: 'print' });
    for (const label of Object.keys(expected)) {
      await shot.emulateMedia({ media: 'screen' });
      await shot.getByRole('button', { name: label }).click();
      await shot.emulateMedia({ media: 'print' });
      const fits = await shot
        .locator('.paper')
        .evaluateAll((sheets) => sheets.every((s) => s.scrollHeight <= s.clientHeight));
      expect(fits, `${label}: fits the page on a desktop browser too`).toBe(true);
      if (process.env.PRINT_SHOTS) {
        await shot.screenshot({ path: `${process.env.PRINT_SHOTS}/${label.at(-2)}.png` });
      }
    }
    await desktop.close();
  }

  // The Doctor can make a template the default; it is preselected next time.
  await page.getByRole('button', { name: 'Clear (C)' }).click();
  await page.getByRole('button', { name: 'Make this the default template' }).click();
  await expect(page.getByText('This is the default template.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Clear (C)' })).toHaveAttribute('aria-pressed', 'true');
});
