/**
 * M2 "clash handling end to end" (PRD §7.4 step 2, §7.5): two phones book the same time while
 * offline. The first to reach the server keeps it; the other phone is told about the clash, taps
 * the notice, moves its booking to a free time, and both phones end up with the same schedule.
 */
import { type Page, expect, test } from '@playwright/test';
import { doctorPhone, openDay, staffPhone } from './helpers.ts';

const card = (page: Page, text: string) => page.locator('.booking').filter({ hasText: text });

async function bookOffline(page: Page, phone: string, name: string, minutes: number) {
  await page.getByRole('button', { name: 'New booking' }).click();
  await page.getByLabel('Phone').fill(phone);
  await page.getByLabel('Patient name').fill(name);
  await page.getByLabel('Time').selectOption(String(minutes));
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(card(page, name).getByText('Not sent yet')).toBeVisible();
}

/** Network back: the app syncs on its own when it sees the `online` event (PRD §7.3). */
async function backOnline(page: Page) {
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.sync-pill')).toHaveText('Synced', { timeout: 15_000 });
}

test('two phones book the same time offline: one wins, the other is told and moves (PRD §7.5)', async ({
  browser,
}) => {
  const doctor = await (await browser.newContext()).newPage();
  await doctorPhone(doctor, 'Clash test Doctor phone');
  const staff = await staffPhone(browser, doctor, 'Tigist', '615204');
  for (const page of [doctor, staff]) {
    await openDay(page, 4);
    await expect(page.locator('.sync-pill')).toHaveText('Synced', { timeout: 15_000 });
    await page.context().setOffline(true);
  }

  await bookOffline(doctor, '0916 12 34 01', 'Abebe Girma', 10 * 60);
  await bookOffline(staff, '0916 12 34 02', 'Tigist Alemu', 10 * 60);

  // The Doctor's phone reaches the server first and keeps 10:00.
  await backOnline(doctor);
  await expect(card(doctor, 'Abebe Girma').getByText('Approved')).toBeVisible();

  // The Staff phone learns its booking lost: marked Clash, with a notice to move it.
  await backOnline(staff);
  await expect(card(staff, 'Tigist Alemu').getByText('Clash', { exact: true })).toBeVisible();
  const notice = staff.getByRole('button', { name: /^Clash: Tigist Alemu at .*Tap to move\.$/ });
  await expect(notice).toBeVisible();

  await notice.click();
  await expect(staff.getByRole('heading', { name: 'Move booking' })).toBeVisible();
  await staff.getByLabel('Time').selectOption(String(11 * 60));
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
