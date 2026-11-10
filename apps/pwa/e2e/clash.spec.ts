/**
 * M2 "clash handling end to end" (PRD §7.4 step 2, §7.5): two phones book the same time while
 * offline. The first to reach the server keeps it; the other phone is told about the clash, taps
 * the notice, moves its booking to a free time, and both phones end up with the same schedule.
 */
import { type Page, expect, test } from '@playwright/test';
import { doctorPhone, openDay, staffPhone } from './helpers.ts';

const card = (page: Page, text: string) => page.locator('.booking').filter({ hasText: text });

/** The times the booking sheet offers (minutes after midnight), in order. */
async function offeredTimes(page: Page): Promise<string[]> {
  // The sheet fills its times once the day is loaded.
  await expect(page.getByLabel('Time').locator('option:not([value=""])').first()).toBeAttached();
  return page
    .getByLabel('Time')
    .locator('option:not([value=""])')
    .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
}

/** Books on an offline phone, at `minutes` or else the first time offered; returns the time used. */
async function bookOffline(page: Page, phone: string, name: string, minutes?: string): Promise<string> {
  await page.getByRole('button', { name: 'New booking' }).click();
  await page.getByLabel('Phone').fill(phone);
  await page.getByLabel('Patient name').fill(name);
  const time = minutes ?? (await offeredTimes(page))[0]!;
  await page.getByLabel('Time').selectOption(time);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(card(page, name).getByText('Not sent yet')).toBeVisible();
  return time;
}

/** Network back: the app syncs on its own when it sees the `online` event (PRD §7.3). */
async function backOnline(page: Page) {
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.sync-pill')).toHaveText('Synced', { timeout: 15_000 });
}

test('two phones book the same time offline: one wins, the other is told and moves (PRD §7.5)', async ({
  browser,
}, testInfo) => {
  const doctor = await (await browser.newContext()).newPage();
  await doctorPhone(doctor, 'Clash test Doctor phone');
  // A retry runs against the same server: it needs a Staff account of its own.
  const staff = await staffPhone(browser, doctor, `Tigist ${testInfo.retry + 1}`, '615204');
  for (const page of [doctor, staff]) {
    await openDay(page, 4);
    await expect(page.locator('.sync-pill')).toHaveText('Synced', { timeout: 15_000 });
    await page.context().setOffline(true);
  }

  // The same time on both phones (whatever the day's first free time is).
  const time = await bookOffline(doctor, '0916 12 34 01', 'Abebe Girma');
  await bookOffline(staff, '0916 12 34 02', 'Tigist Alemu', time);

  // The Doctor's phone reaches the server first and keeps the time.
  await backOnline(doctor);
  await expect(card(doctor, 'Abebe Girma').getByText('Approved')).toBeVisible();

  // The Staff phone learns its booking lost: marked Clash, with a notice to move it.
  await backOnline(staff);
  await expect(card(staff, 'Tigist Alemu').getByText('Clash', { exact: true })).toBeVisible();
  const notice = staff.getByRole('button', { name: /^Clash: Tigist Alemu at .*Tap to move\.$/ });
  await expect(notice).toBeVisible();

  await notice.click();
  await expect(staff.getByRole('heading', { name: 'Move booking' })).toBeVisible();
  // The move sheet offers only free times; take the first that isn't the lost one.
  const free = (await offeredTimes(staff)).find((t) => t !== time);
  await staff.getByLabel('Time').selectOption(free!);
  // Saving sends the move at once.
  await staff.getByRole('button', { name: 'Save' }).click();
  // Moved by Staff: it goes back to the Doctor for approval (PRD §21 #2), and the notice is gone.
  await expect(card(staff, 'Tigist Alemu').getByText('Waiting for approval')).toBeVisible();
  await expect(notice).toHaveCount(0);

  // Both phones agree (opening the app again syncs it).
  await doctor.reload();
  await openDay(doctor, 4);
  await expect(card(doctor, 'Tigist Alemu').getByText('Waiting for approval')).toBeVisible();
  await expect(card(doctor, 'Abebe Girma').getByText('Approved')).toBeVisible();
});
