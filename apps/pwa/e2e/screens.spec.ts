/**
 * Screenshots of the main screens for design reviews (not a test of behaviour). Skipped unless
 * SCREENS_OUT is set:  SCREENS_OUT=<dir> pnpm --filter @yegna/pwa e2e screens
 * Uses made-up patients only. Light and dark, phone size.
 */
import { join, resolve } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { doctorPhone, openDay } from './helpers.ts';

const OUT = process.env.SCREENS_OUT ? resolve(process.env.SCREENS_OUT) : undefined;

async function book(page: Page, phone: string, name: string) {
  await page.getByRole('button', { name: 'New booking' }).click();
  await page.getByLabel('Phone').fill(phone);
  await page.getByLabel('Patient name').fill(name);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.booking').filter({ hasText: name })).toHaveCount(1);
}

test('screens for design review', async ({ page }) => {
  test.skip(!OUT, 'set SCREENS_OUT to save screenshots');
  test.setTimeout(180_000);
  const shot = async (name: string) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: join(OUT!, `${name}-${scheme}.png`), fullPage: true });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  };

  await page.goto('/');
  await shot('01-welcome');
  await doctorPhone(page, 'Design review phone');
  await shot('02-today-empty');
  await openDay(page, 1);
  await book(page, '0911 22 33 44', 'Abebe Kebede');
  await book(page, '0922 33 44 55', 'ሐና ታደሰ');
  await book(page, '0933 44 55 66', 'Meseret Alemu');
  await shot('03-day');
  await page.getByRole('button', { name: 'New booking' }).click();
  await page.getByLabel('Phone').pressSequentially('0911', { delay: 30 });
  await shot('04-booking-sheet');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.booking').filter({ hasText: 'Abebe Kebede' }).click();
  await shot('04b-booking-details');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Week' }).click();
  await shot('04c-week');
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Day' }).click();
  await page.goto('/#/patients');
  await shot('04d-patients');
  await page.getByRole('button', { name: /Abebe Kebede/ }).click();
  await shot('04e-patient-profile');
  await page.goto('/#/settings');
  await shot('05-settings');
  await page.goto('/#/calls');
  await shot('06-calls');
  await page.goto('/#/approvals');
  await shot('07-approvals');
});
