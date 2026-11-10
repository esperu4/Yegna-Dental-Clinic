/**
 * The booking critical path (PRD §8 item 5, M1 acceptance): a returning patient is booked by phone
 * number in ≤ 3 taps and < 30 s. Recorded (video) and timed.
 */
import { type Page, expect, test } from '@playwright/test';
import { doctorPhone, openDay } from './helpers.ts';

const MAX_TAPS = 3;
const MAX_MS = 30_000;

test.use({ video: 'on' });

test('a returning patient is booked by phone in ≤ 3 taps and < 30 s', async ({ page }, testInfo) => {
  await doctorPhone(page, 'Booking test phone');
  await openDay(page, 1);

  // First visit: a new patient, typed in full.
  await page.getByRole('button', { name: 'New booking' }).click();
  await page.getByLabel('Phone').fill('0911 22 33 44');
  await page.getByLabel('Patient name').fill('Abebe Kebede');
  await page.getByRole('button', { name: 'Save' }).click();
  const first = page.locator('.booking').filter({ hasText: 'Abebe Kebede' });
  await expect(first).toHaveCount(1);
  // Accepted by the server (Doctor's bookings are approved automatically).
  await expect(first.getByText('Approved')).toBeVisible({ timeout: 15_000 });

  // The returning patient: tap +, type the phone, tap the suggestion, tap Save.
  let taps = 0;
  const tap = async (target: ReturnType<Page['getByRole']>) => {
    taps++;
    await target.click();
  };
  const started = Date.now();
  await tap(page.getByRole('button', { name: 'New booking' }));
  await page.getByLabel('Phone').pressSequentially('0911 22', { delay: 50 });
  await tap(
    page.getByRole('list', { name: 'Matching patients' }).getByRole('button', { name: /Abebe Kebede/ }),
  );
  await tap(page.getByRole('button', { name: 'Save' }));
  await expect(page.locator('.booking').filter({ hasText: 'Abebe Kebede' })).toHaveCount(2);
  const elapsed = Date.now() - started;

  testInfo.annotations.push(
    { type: 'taps', description: String(taps) },
    { type: 'elapsed_ms', description: String(elapsed) },
  );
  await testInfo.attach('timing.json', {
    body: JSON.stringify({ taps, elapsedMs: elapsed, limitTaps: MAX_TAPS, limitMs: MAX_MS }),
    contentType: 'application/json',
  });
  expect(taps).toBeLessThanOrEqual(MAX_TAPS);
  expect(elapsed).toBeLessThan(MAX_MS);

  // Card actions: the patient arrives and shows in the waiting strip.
  await page.locator('.booking').filter({ hasText: 'Abebe Kebede' }).first().click();
  await page.getByRole('button', { name: 'Arrived' }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.waiting').getByRole('button', { name: 'Abebe Kebede' })).toBeVisible();

  // Hard error: nothing can be booked after closing time.
  await page.getByRole('button', { name: 'New booking' }).click();
  await page.getByLabel('Phone').pressSequentially('0911 22');
  await page
    .getByRole('list', { name: 'Matching patients' })
    .getByRole('button', { name: /Abebe Kebede/ })
    .click();
  // 17:45 local (the option values are minutes since midnight; labels follow the user's clock).
  await page.getByLabel('Time').selectOption(String(17 * 60 + 45));
  await expect(page.getByText('This ends after the clinic closes.')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.booking').filter({ hasText: 'Abebe Kebede' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Cancel' }).click();

  // The Doctor leaves early this day: later times become a hard error.
  await page.getByRole('button', { name: 'Change this day' }).click();
  await page.getByLabel('Closes').selectOption(String(15 * 60));
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'New booking' }).click();
  await page.getByLabel('Phone').pressSequentially('0911 22');
  await page
    .getByRole('list', { name: 'Matching patients' })
    .getByRole('button', { name: /Abebe Kebede/ })
    .click();
  await expect(page.getByLabel('Time').locator('option', { hasText: /.+/ }).last()).toHaveAttribute(
    'value',
    String(14 * 60 + 45),
  );
  await page.getByRole('button', { name: 'Cancel' }).click();

  // A block: the time inside it can't be booked.
  await page.getByRole('button', { name: 'Block time' }).click();
  await page.getByLabel('From').selectOption(String(13 * 60));
  await page.getByLabel('Until').selectOption(String(14 * 60));
  await page.getByLabel('Reason (optional)').fill('Meeting');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Blocked: .* · Meeting/)).toBeVisible();
  await page.getByRole('button', { name: 'New booking' }).click();
  await page.getByLabel('Phone').pressSequentially('0911 22');
  await page
    .getByRole('list', { name: 'Matching patients' })
    .getByRole('button', { name: /Abebe Kebede/ })
    .click();
  await page.getByLabel('Time').selectOption(String(13 * 60 + 30));
  await expect(page.getByText('The Doctor blocked this time.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Holidays: the fixed public holidays are added in one tap (and not twice).
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Holidays/ }).click();
  const addFixed = page.getByRole('button', { name: 'Add this year’s fixed public holidays' });
  await addFixed.click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Ethiopian Christmas' }).first()).toBeVisible();
  await expect(addFixed).toBeEnabled(); // all added
  const count = await page.getByRole('listitem').count();
  await addFixed.click();
  await expect(addFixed).toBeEnabled();
  await expect(page.getByRole('listitem')).toHaveCount(count);
});
