/** Shared steps for the PWA end-to-end specs (one fresh local API + D1 per run). */
import { type Browser, type Page, expect } from '@playwright/test';

export const SETUP_CODE = 'e2e-setup-code-0123456789abcdef0123456789';
export const DOCTOR = { name: 'Dr. Selam', pin: '258014' };

/** Signs the Doctor in on a fresh phone: sets the clinic up if no one has, else enrols. */
export async function doctorPhone(page: Page, label = 'Test phone') {
  await page.goto('/');
  await page.getByRole('button', { name: 'English' }).click();
  const setup = page.getByRole('button', { name: 'Set up the clinic (Doctor)' });
  const enrol = page.getByRole('button', { name: 'Sign in on this phone' });
  await expect(enrol).toBeVisible();
  if (await setup.isVisible()) {
    await setup.click();
    await page.getByLabel('Setup code').fill(SETUP_CODE);
    await page.getByLabel('Your name').fill(DOCTOR.name);
    await page.getByLabel('PIN (6 digits)').fill(DOCTOR.pin);
    await page.getByLabel('Repeat PIN').fill(DOCTOR.pin);
    await page.getByLabel('Name for this phone').fill(label);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Skip for now' }).click();
  } else {
    await enrol.click();
    await page.getByLabel('Your name').fill(DOCTOR.name);
    await page.getByLabel('PIN (4–6 digits)').fill(DOCTOR.pin);
    await page.getByLabel('Name for this phone').fill(label);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** A Staff phone for a new Staff account the Doctor adds from `doctor`'s Settings. */
export async function staffPhone(browser: Browser, doctor: Page, name: string, pin: string): Promise<Page> {
  await doctor.getByRole('button', { name: 'Settings' }).click();
  await doctor.getByRole('button', { name: /Staff accounts/ }).click();
  await doctor.getByLabel('Your name').fill(name);
  await doctor.getByLabel('PIN (4–6 digits)').fill(pin);
  await doctor.getByRole('button', { name: 'Add Staff' }).click();
  await expect(doctor.getByRole('listitem').filter({ hasText: name })).toBeVisible();
  await doctor.goBack();
  await doctor.goBack();

  const staff = await (await browser.newContext()).newPage();
  await staff.goto('/');
  await staff.getByRole('button', { name: 'English' }).click();
  await staff.getByRole('button', { name: 'Sign in on this phone' }).click();
  await staff.getByLabel('Your name').fill(name);
  await staff.getByLabel('PIN (4–6 digits)').fill(pin);
  await staff.getByLabel('Name for this phone').fill(`${name} phone`);
  await staff.getByRole('button', { name: 'Continue' }).click();
  // New Staff accounts start in Amharic (PRD §3); switch this phone to English from the header.
  await expect(staff.getByRole('heading', { name: 'ዛሬ' })).toBeVisible();
  await staff.getByRole('button', { name: 'ቋንቋ ቀይር (አማርኛ / እንግሊዝኛ)' }).click();
  await expect(staff.getByRole('heading', { name: 'Today' })).toBeVisible();
  return staff;
}

/**
 * Moves the Today view to the `nth` (1-based) day from tomorrow that the clinic is open. Specs use
 * different days so the Doctor's day rules and blocks in one spec don't affect another.
 */
export async function openDay(page: Page, nth: number) {
  let found = 0;
  const shownDay = page.locator('.day-picker > span').first();
  const closed = page.getByText('The clinic is closed this day.');
  for (let i = 0; i < 21; i++) {
    const before = await shownDay.textContent();
    await page.getByRole('button', { name: 'Next day' }).click();
    // Wait until the next day is drawn (open: its timeline; closed: the notice) before deciding,
    // or a closed day still loading would count as open.
    await expect(shownDay).not.toHaveText(before ?? '');
    await expect(closed.or(page.locator('.timeline'))).toBeVisible();
    if (await closed.isVisible()) continue;
    if (++found === nth) return;
  }
  throw new Error(`no ${nth}th open day within three weeks`);
}
