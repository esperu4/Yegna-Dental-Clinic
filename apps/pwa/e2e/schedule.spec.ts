/**
 * M1 schedule criteria end to end (PRD §8 items 3–6, 12; §9): Staff booking approved by the Doctor,
 * every card action, the lunch warning, Week view, the language/calendar switches in the header,
 * and procedures edit/delete.
 */
import { type Page, expect, test } from '@playwright/test';
import { doctorPhone, openDay, staffPhone } from './helpers.ts';

const card = (page: Page, text: string | RegExp) => page.locator('.booking').filter({ hasText: text });

async function openSheetFor(page: Page, phoneStart: string, name: string) {
  await page.getByRole('button', { name: 'New booking' }).click();
  await page.getByLabel('Phone').pressSequentially(phoneStart);
  await page
    .getByRole('list', { name: 'Matching patients' })
    .getByRole('button', { name: new RegExp(name) })
    .click();
}

test('schedule: approval, card actions, lunch warning, week view, header switches', async ({ browser }) => {
  const doctor = await (await browser.newContext()).newPage();
  await doctorPhone(doctor, 'Schedule test phone');
  const staff = await staffPhone(browser, doctor, 'Meron', '4826');
  await expect(staff.getByRole('heading', { name: 'Today' })).toBeVisible();

  // Staff book a new patient: it waits for the Doctor's approval (PRD §10).
  await openDay(staff, 2);
  await staff.getByRole('button', { name: 'New booking' }).click();
  await staff.getByLabel('Phone').fill('0912 33 44 55');
  await staff.getByLabel('Patient name').fill('Tigist Alemu');
  await staff.getByLabel('Time').selectOption(String(9 * 60));
  await staff.getByRole('button', { name: 'Save' }).click();
  await expect(card(staff, 'Tigist Alemu').getByText('Waiting for approval')).toBeVisible({
    timeout: 15_000,
  });
  // Staff can't approve.
  await card(staff, 'Tigist Alemu').click();
  await expect(staff.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await staff.getByRole('button', { name: 'Close' }).click();

  // The Doctor sees it after syncing and approves it; then Arrived and Done.
  await doctor.reload();
  await openDay(doctor, 2);
  await card(doctor, 'Tigist Alemu').click();
  await doctor.getByRole('button', { name: 'Approve' }).click();
  await expect(doctor.locator('.sheet').getByText('Approved')).toBeVisible();
  await doctor.getByRole('button', { name: 'Arrived' }).click();
  await doctor.getByRole('button', { name: 'Done' }).click();
  await doctor.getByRole('button', { name: 'Close' }).click();
  await expect(card(doctor, 'Tigist Alemu').getByText('Done')).toBeVisible();

  // Lunch is soft: a warning, then "Book anyway?".
  await openSheetFor(doctor, '0912 33', 'Tigist Alemu');
  await doctor.getByLabel('Time').selectOption(String(12 * 60));
  await expect(doctor.getByText('This is lunch time.')).toBeVisible();
  doctor.once('dialog', (d) => d.accept());
  await doctor.getByRole('button', { name: 'Save' }).click();
  await expect(card(doctor, 'Tigist Alemu')).toHaveCount(2);

  // Reschedule the lunch booking to 14:00.
  await card(doctor, /Approved/)
    .filter({ hasText: 'Tigist Alemu' })
    .click();
  await doctor.getByRole('button', { name: 'Reschedule' }).click();
  await expect(doctor.getByRole('heading', { name: 'Move booking' })).toBeVisible();
  await doctor.getByLabel('Time').selectOption(String(14 * 60));
  await doctor.getByRole('button', { name: 'Save' }).click();
  await expect(doctor.getByRole('heading', { name: 'Move booking' })).toHaveCount(0);

  // Cancel it with a reason: it leaves the timeline.
  await card(doctor, /Approved/)
    .filter({ hasText: 'Tigist Alemu' })
    .click();
  doctor.once('dialog', (d) => d.accept('Patient asked to cancel'));
  await doctor.getByRole('button', { name: 'Cancel booking' }).click();
  await expect(card(doctor, 'Tigist Alemu')).toHaveCount(1);

  // Book next visit: the sheet opens with the patient already chosen; Call shows the number.
  await card(doctor, 'Tigist Alemu').click();
  await expect(doctor.getByRole('link', { name: /Call 0912 33 44 55/ })).toBeVisible();
  await doctor.getByRole('button', { name: 'Book next visit' }).click();
  await expect(doctor.locator('.picked').getByText('Tigist Alemu')).toBeVisible();
  await doctor.getByRole('button', { name: 'Cancel' }).click();

  // Week view: Monday–Saturday with counts; tapping a day opens it.
  await doctor.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(doctor.getByRole('heading', { name: 'Week' })).toBeVisible();
  await expect(doctor.locator('.week li')).toHaveCount(6);
  await doctor.locator('.week li').first().getByRole('button').click();
  await expect(doctor.getByRole('heading', { name: /Today|Day/ })).toBeVisible();

  // Header switches: Gregorian clock, then Amharic, then back.
  await doctor.getByRole('button', { name: 'Switch calendar (Ethiopian / Gregorian)' }).click();
  await expect(doctor.getByRole('button', { name: 'Switch calendar (Ethiopian / Gregorian)' })).toHaveText(
    'GC',
  );
  await doctor.getByRole('button', { name: 'Switch language (Amharic / English)' }).click();
  await expect(doctor.getByRole('button', { name: 'ማስተካከያ' })).toBeVisible();
  await doctor.getByRole('button', { name: 'ቋንቋ ቀይር (አማርኛ / እንግሊዝኛ)' }).click();
  await expect(doctor.getByRole('button', { name: 'Settings' })).toBeVisible();
  // The choice belongs to the account: it survives a reload.
  await doctor.reload();
  await expect(doctor.getByRole('button', { name: 'Switch calendar (Ethiopian / Gregorian)' })).toHaveText(
    'GC',
  );
});

test('procedures can be edited and deleted (PRD §8 item 12)', async ({ page }) => {
  await doctorPhone(page, 'Procedures test phone');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Procedures/ }).click();
  await page.getByRole('button', { name: '+ Add procedure' }).click();
  await page.getByLabel('Name in Amharic').fill('ራጅ');
  await page.getByLabel('Name in English').fill('X-ray');
  await page.getByLabel('Code (1–3 letters)').fill('xr');
  await page.getByRole('button', { name: 'Save' }).click();
  const row = page.getByRole('listitem').filter({ hasText: 'X-ray' });
  await expect(row.getByText('XR', { exact: true })).toBeVisible();

  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Name in English').fill('Dental X-ray');
  await page.getByLabel('In use').uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  const edited = page.getByRole('listitem').filter({ hasText: 'Dental X-ray' });
  await expect(edited.getByText(/Not in use/)).toBeVisible();

  page.once('dialog', (d) => d.accept());
  await edited.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Dental X-ray' })).toHaveCount(0);
});

test('the sync pill shows offline, then sends what was booked offline (PRD §7.6)', async ({
  page,
  context,
}) => {
  await doctorPhone(page, 'Pill test phone');
  await openDay(page, 3);
  const pill = page.locator('.sync-pill');
  await expect(pill).toHaveText('Synced', { timeout: 15_000 });

  await context.setOffline(true);
  await expect(pill).toHaveText(/Offline since/);
  await page.getByRole('button', { name: 'New booking' }).click();
  await page.getByLabel('Phone').fill('0913 44 55 66');
  await page.getByLabel('Patient name').fill('Offline Patient');
  await page.getByLabel('Time').selectOption(String(10 * 60));
  await page.getByRole('button', { name: 'Save' }).click();
  const booked = page.locator('.booking').filter({ hasText: 'Offline Patient' });
  await expect(booked.getByText('Not sent yet')).toBeVisible();
  await pill.click();
  await expect(page.getByText(/changes are saved on this phone/)).toBeVisible();

  await context.setOffline(false);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(pill).toHaveText('Synced', { timeout: 15_000 });
  await expect(booked.getByText('Approved')).toBeVisible();
});
