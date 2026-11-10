/**
 * M3 call list and approvals (PRD §8 items 7–8, §10, ADR 0008). Both phones' clocks are set to a
 * Sunday 10:00 (clinic time), so "tomorrow" is a Monday the clinic is open, whatever day CI runs.
 */
import { type Page, expect, test } from '@playwright/test';
import { doctorPhone, openDay, staffPhone } from './helpers.ts';

/**
 * A Sunday at 10:00 in Addis Ababa (07:00 UTC), three weeks or more from now: past the days the
 * other specs book on (they share one server), so its Monday is free.
 */
function comingSunday(): Date {
  const d = new Date(Date.now() + 21 * 86_400_000);
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  d.setUTCHours(7, 0, 0, 0);
  return d;
}

test('the call list and approvals (PRD §8 items 7–8)', async ({ browser }, testInfo) => {
  const sunday = comingSunday();
  const setClock = (page: Page) => page.clock.setFixedTime(sunday);

  const doctor = await (await browser.newContext()).newPage();
  await setClock(doctor);
  await doctorPhone(doctor, 'Calls test Doctor phone');
  const staff = await staffPhone(browser, doctor, `Meseret ${testInfo.retry + 1}`, '731905', setClock);

  // Staff book tomorrow 09:00 for a patient without Telegram: it waits for approval, and the
  // visit is less than 24 h away, so it is on the call list for both reasons.
  await openDay(staff, 1);
  await staff.getByRole('button', { name: 'New booking' }).click();
  await staff.getByLabel('Phone').fill('0917 11 22 33');
  await staff.getByLabel('Patient name').fill('Kebede Call');
  await staff.getByLabel('Time').selectOption(String(9 * 60));
  await staff.getByRole('button', { name: 'Save' }).click();
  await expect(staff.locator('.sync-pill')).toHaveText('Synced', { timeout: 15_000 });

  await staff.getByRole('button', { name: 'Call list · 1' }).click();
  const row = staff.getByRole('listitem').filter({ hasText: 'Kebede Call' });
  await expect(row.getByText(/No Telegram/)).toBeVisible();
  await expect(row.getByText(/Not approved yet/)).toBeVisible();
  await expect(row.getByRole('link', { name: /Call/ })).toHaveAttribute('href', 'tel:+251917112233');

  // No answer: the row stays, marked tried. Confirmed: it leaves the list.
  await row.getByRole('button', { name: 'No answer' }).click();
  await expect(row.getByText(/No answer at/)).toBeVisible();
  await row.getByRole('button', { name: 'Confirmed' }).click();
  await expect(staff.getByText('Nobody to call right now.')).toBeVisible();

  // The Doctor approves it from Approvals.
  await doctor.reload();
  await doctor.getByRole('button', { name: 'Approvals · 1' }).click();
  await expect(doctor.getByText('Kebede Call')).toBeVisible();
  await doctor.getByRole('button', { name: 'Approve all for this day (1)' }).click();
  await expect(doctor.getByText('Nothing waiting for approval.')).toBeVisible();
});
