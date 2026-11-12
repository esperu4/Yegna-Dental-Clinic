/**
 * M4 imports review (PRD §8 item 10, §12, §20 "import via bot and via PWA; review screen"): a sheet
 * the readers have read is reviewed on the phone: a bad phone is caught before anything is sent,
 * the unreadable row is skipped, and the confirmed rows become bookings through sync.
 *
 * The read sheet is put straight into the local D1 (reading needs Telegram and an AI reader; both
 * are covered by the API tests).
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { sheetIdFor, uuidv7 } from '@yegna/shared/client';
import { doctorPhone } from './helpers.ts';

const apiDir = join(import.meta.dirname, '..', '..', 'api');
const persist = join(import.meta.dirname, '..', '.e2e-state');
const q = (v: string) => (process.platform === 'win32' ? `"${v}"` : v);

/** Runs SQL against the e2e API's local D1. */
function d1(sql: string, file: string) {
  writeFileSync(file, sql);
  const run = spawnSync(
    'pnpm',
    ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', q(persist), '--file', q(file)],
    { cwd: apiDir, shell: process.platform === 'win32', env: { ...process.env, CI: '1' }, encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`d1 execute failed: ${run.stderr || run.stdout}`);
}

/**
 * The Monday after next in Addis Ababa (UTC+3, no daylight saving): 8–14 days ahead, past the days
 * the other specs book on (their first few open days share this D1), so no booking clashes.
 */
function mondayAfterNext(): string {
  const addis = new Date(Date.now() + 3 * 3_600_000);
  const ahead = ((1 - addis.getUTCDay() + 7) % 7 || 7) + 7;
  return new Date(addis.getTime() + ahead * 86_400_000).toISOString().slice(0, 10);
}
const addisUtc = (date: string, hour: number) => Date.parse(`${date}T00:00:00Z`) + (hour - 3) * 3_600_000;

test('a read sheet is reviewed, fixed and confirmed into bookings (PRD §12)', async ({ page }, info) => {
  await doctorPhone(page, 'Imports phone');

  const monday = mondayAfterNext();
  const sheetId = sheetIdFor({ template: 'F', monday });
  const importId = uuidv7();
  const [good, badPhone, unreadable] = [uuidv7(), uuidv7(), uuidv7()];
  const now = Date.now();
  const meta = `1, ${now}, NULL, NULL`;
  d1(
    `INSERT INTO imports (id, telegram_file_id, uploaded_by, template, period_label, status, provider, created_at, version, updated_at, updated_by, deleted_at)
       VALUES ('${importId}', 'e2e-file', (SELECT id FROM users LIMIT 1), 'F', '${sheetId}', 'read', 'stub', ${now}, ${meta});
     INSERT INTO import_rows (id, import_id, day_text, time_text, name_text, phone_text, code_text, confidence, match, start_at, needs_check, version, updated_at, updated_by, deleted_at) VALUES
       ('${good}', '${importId}', 'Mon', '4', 'Almaz Tesfaye', '0911000001', NULL, 90, 'new', ${addisUtc(monday, 10)}, 0, ${meta}),
       ('${badPhone}', '${importId}', 'Mon', '5', 'Bekele Girma', '0911', NULL, 40, 'new', ${addisUtc(monday, 11)}, 1, ${meta}),
       ('${unreadable}', '${importId}', NULL, NULL, NULL, NULL, NULL, 10, 'unreadable', NULL, 0, ${meta});`,
    info.outputPath('seed.sql'),
  );

  await page.getByRole('button', { name: 'Sheet photos' }).click();
  await expect(page.getByRole('heading', { name: 'Sheet photos' })).toBeVisible();
  await expect(page.getByText('Ready to review · 3 rows · 2 to check')).toBeVisible();
  await page.getByRole('button', { name: new RegExp(sheetId) }).click();
  await expect(page.getByRole('heading', { name: 'Review sheet' })).toBeVisible();
  // No Team bot locally: the photo cannot be fetched, the rows can still be reviewed.
  await expect(page.getByText('The photo is not available.')).toBeVisible();

  const rows = page.locator('.import-rows > li');
  await expect(rows).toHaveCount(3);
  const unreadableRow = rows.filter({ hasText: 'Unreadable' });
  const bekele = rows.filter({ hasText: 'Bekele Girma' });
  await expect(unreadableRow.getByRole('checkbox')).not.toBeChecked();
  await expect(bekele).toContainText('Check this row');

  // IMPORT_SHOTS=<dir> saves how the review looks on a phone (for design checks).
  if (process.env.IMPORT_SHOTS) {
    await page.screenshot({ path: join(process.env.IMPORT_SHOTS, 'import-review.png'), fullPage: true });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // The bad phone is caught on the phone; nothing is sent.
  await page.getByRole('button', { name: 'Confirm: book 2, skip 1' }).click();
  await expect(page.getByText('Fix the rows marked in red, or skip them.')).toBeVisible();
  await expect(bekele).toContainText('This phone number is not valid');
  await expect(rows.filter({ hasText: 'Almaz Tesfaye' })).not.toContainText('not valid');
  await bekele.getByLabel('Phone').fill('0911000002');
  await page.getByRole('button', { name: 'Confirm: book 2, skip 1' }).click();
  await expect(page.getByText('Sent 2 bookings.')).toBeVisible();

  // After sync the server shows both rows booked and the import reviewed.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('This sheet was reviewed.')).toBeVisible();
    await expect(page.locator('.import-rows > li').filter({ hasText: 'Booked' })).toHaveCount(2, {
      timeout: 2_000,
    });
  }).toPass({ timeout: 45_000 });
  await expect(page.locator('.import-rows > li').filter({ hasText: 'Skipped' })).toHaveCount(1);

  // The bookings are on the schedule, with their new patients.
  await page.goto('/');
  const shownDay = page.locator('.day-picker > span[data-date]').first();
  for (let i = 0; i < 14 && (await shownDay.getAttribute('data-date')) !== monday; i++) {
    const before = await shownDay.getAttribute('data-date');
    await page.getByRole('button', { name: 'Next day' }).click();
    await expect(shownDay).not.toHaveAttribute('data-date', before ?? '');
  }
  await expect(shownDay).toHaveAttribute('data-date', monday);
  await expect(page.getByText('Almaz Tesfaye')).toBeVisible();
  await expect(page.getByText('Bekele Girma')).toBeVisible();
});
