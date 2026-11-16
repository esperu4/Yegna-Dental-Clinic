/**
 * Patients (PRD §8 item 9): search, profile with upcoming visits, edit, and the Doctor's delete,
 * which erases the patient (ADR 0007).
 */
import { expect, test } from '@playwright/test';
import { doctorPhone, openDay } from './helpers.ts';

test('patients: search, profile, edit, delete (PRD §8 item 9)', async ({ page }) => {
  await doctorPhone(page, 'Patients test phone');
  await openDay(page, 4);
  await page.getByRole('button', { name: 'New booking' }).click();
  await page.getByLabel('Phone').fill('0944 55 66 77');
  await page.getByLabel('Patient name').fill('Tigist Bekele');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.booking').filter({ hasText: 'Tigist Bekele' })).toHaveCount(1);

  await page.getByRole('button', { name: 'Patients' }).click();
  await page.getByLabel('Search by name or phone').fill('0944');
  await page.getByRole('button', { name: /Tigist Bekele/ }).click();
  await expect(page.getByRole('heading', { name: 'Tigist Bekele' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Upcoming visits' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Call 0944 55 66 77' })).toBeVisible();

  // Edit: a bad phone is refused inline; a good one and a note are saved.
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Phone').fill('12');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Enter a valid Ethiopian phone number.')).toBeVisible();
  await page.getByLabel('Phone').fill('0944 55 66 78');
  await page.getByLabel('Note (optional)').fill('Prefers mornings');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('link', { name: 'Call 0944 55 66 78' })).toBeVisible();
  await expect(page.getByText('Prefers mornings')).toBeVisible();

  // Delete (Doctor): confirmed, then gone from the list.
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('heading', { name: 'Patients' })).toBeVisible();
  await page.getByLabel('Search by name or phone').fill('Tigist Bekele');
  await expect(page.getByText('No patient matches this search.')).toBeVisible();
});
