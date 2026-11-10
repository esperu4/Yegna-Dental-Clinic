import { type Page, expect, test } from '@playwright/test';

const SETUP_CODE = 'e2e-setup-code-0123456789abcdef0123456789';

async function english(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'English' }).click();
}

test('Doctor sets up the clinic, adds Staff; Staff enrols; Doctor revokes the phone', async ({ browser }) => {
  // Doctor's phone
  const doctor = await (await browser.newContext()).newPage();
  await english(doctor);
  await doctor.getByRole('button', { name: 'Set up the clinic (Doctor)' }).click();
  await doctor.getByLabel('Setup code').fill(SETUP_CODE);
  await doctor.getByLabel('Your name').fill('Dr. Selam');
  await doctor.getByLabel('PIN (6 digits)').fill('2580');
  await doctor.getByLabel('Repeat PIN').fill('2580');
  await doctor.getByLabel('Name for this phone').fill('Doctor phone');
  await doctor.getByRole('button', { name: 'Continue' }).click();
  await expect(doctor.getByText('The Doctor’s PIN must be 6 digits.')).toBeVisible();
  await doctor.getByLabel('PIN (6 digits)').fill('258014');
  await doctor.getByLabel('Repeat PIN').fill('258014');
  await doctor.getByRole('button', { name: 'Continue' }).click();

  // First run: the setup steps (PRD §8 item 2). Language and calendar…
  await expect(doctor.getByRole('heading', { name: 'Set up your clinic' })).toBeVisible();
  await expect(doctor.getByText('Step 1 of 5')).toBeVisible();
  await doctor.getByRole('button', { name: 'Next' }).click();
  // …clinic hours: close on Saturdays…
  await expect(doctor.getByText('Step 2 of 5')).toBeVisible();
  const saturday = doctor.getByRole('group', { name: 'Saturday' }).first();
  await saturday.getByRole('button', { name: 'Closed' }).click();
  await doctor.getByRole('button', { name: 'Save' }).click();
  await expect(doctor.getByText('Saved.')).toBeVisible();
  await doctor.getByRole('button', { name: 'Next' }).click();
  // …procedures: the code must be unique…
  await doctor.getByRole('button', { name: '+ Add procedure' }).click();
  await doctor.getByLabel('Name in Amharic').fill('ጽዳት');
  await doctor.getByLabel('Name in English').fill('Cleaning');
  await doctor.getByLabel('Code (1–3 letters)').fill('c');
  await doctor.getByLabel('Usual length').selectOption('45');
  await doctor.getByRole('button', { name: 'Save' }).click();
  const cleaning = doctor.getByRole('listitem').filter({ hasText: 'Cleaning' });
  await expect(cleaning.getByText('C', { exact: true })).toBeVisible();
  await expect(cleaning.getByText('45 min')).toBeVisible();
  await doctor.getByRole('button', { name: '+ Add procedure' }).click();
  await doctor.getByLabel('Name in Amharic').fill('ምርመራ');
  await doctor.getByLabel('Name in English').fill('Check-up');
  await doctor.getByLabel('Code (1–3 letters)').fill('C');
  await doctor.getByRole('button', { name: 'Save' }).click();
  await expect(doctor.getByText('Another procedure already has this code.')).toBeVisible();
  await doctor.getByLabel('Code (1–3 letters)').fill('CU');
  await doctor.getByRole('button', { name: 'Save' }).click();
  await expect(doctor.getByRole('listitem').filter({ hasText: 'Check-up' })).toBeVisible();
  // …Telegram (later), notifications, done.
  await doctor.getByRole('button', { name: 'Next' }).click();
  await doctor.getByRole('button', { name: 'Next' }).click();
  await doctor.getByRole('button', { name: 'Finish' }).click();
  await expect(doctor.getByRole('heading', { name: 'Today' })).toBeVisible();

  // Add a Staff account
  await doctor.getByRole('button', { name: 'Settings' }).click();
  await doctor.getByRole('button', { name: /Staff accounts/ }).click();
  await doctor.getByLabel('Your name').fill('Hana');
  await doctor.getByLabel('PIN (4–6 digits)').fill('1234');
  await doctor.getByRole('button', { name: 'Add Staff' }).click();
  await expect(doctor.getByText(/too easy to guess/)).toBeVisible();
  await doctor.getByLabel('PIN (4–6 digits)').fill('4731');
  await doctor.getByRole('button', { name: 'Add Staff' }).click();
  await expect(doctor.getByRole('listitem').filter({ hasText: 'Hana' })).toBeVisible();

  // Staff's phone enrols
  const staff = await (await browser.newContext()).newPage();
  await english(staff);
  await expect(staff.getByRole('button', { name: 'Set up the clinic (Doctor)' })).toHaveCount(0);
  await staff.getByRole('button', { name: 'Sign in on this phone' }).click();
  await staff.getByLabel('Your name').fill('hana');
  await staff.getByLabel('PIN (4–6 digits)').fill('0000');
  await staff.getByLabel('Name for this phone').fill('Front desk');
  await staff.getByRole('button', { name: 'Continue' }).click();
  await expect(staff.getByText('Name or PIN is wrong.')).toBeVisible();
  await staff.getByLabel('PIN (4–6 digits)').fill('4731');
  await staff.getByRole('button', { name: 'Continue' }).click();
  // Hana's account is in Amharic (the default), so the app switches to her language.
  await expect(staff.getByRole('heading', { name: 'ዛሬ' })).toBeVisible();
  await expect(staff.getByText('Hana')).toBeVisible();
  await staff.getByRole('button', { name: 'ማስተካከያ' }).click();
  await expect(staff.getByRole('button', { name: /የሠራተኞች መለያዎች/ })).toHaveCount(0);

  // Doctor revokes the Staff phone
  await doctor.goBack();
  await doctor.getByRole('button', { name: /Phones/ }).click();
  const row = doctor.getByRole('listitem').filter({ hasText: 'Front desk' });
  doctor.once('dialog', (d) => d.accept());
  await row.getByRole('button', { name: 'Sign out this phone' }).click();
  await expect(row.getByText('Signed out')).toBeVisible();

  // The Staff phone is wiped at its next request
  // (Hana's phone is in Amharic: "Gregorian" button, then the "signed out by the Doctor" notice.)
  await staff.getByRole('button', { name: 'ግሪጎሪያን' }).click();
  await expect(staff.getByText('ሐኪሟ ይህን ስልክ አስወጥተዋል። መረጃው ተሰርዟል።')).toBeVisible();
  await staff.reload();
  await expect(staff.getByRole('button', { name: 'በዚህ ስልክ ይግቡ' })).toBeVisible();

  // The Doctor's procedures and hours reached the server: a second Doctor phone receives them.
  const tablet = await (await browser.newContext()).newPage();
  await english(tablet);
  await tablet.getByRole('button', { name: 'Sign in on this phone' }).click();
  await tablet.getByLabel('Your name').fill('Dr. Selam');
  await tablet.getByLabel('PIN (4–6 digits)').fill('258014');
  await tablet.getByLabel('Name for this phone').fill('Tablet');
  await tablet.getByRole('button', { name: 'Continue' }).click();
  await tablet.getByRole('button', { name: 'Settings' }).click();
  await tablet.getByRole('button', { name: /Procedures/ }).click();
  await expect(tablet.getByRole('listitem').filter({ hasText: 'Cleaning' })).toBeVisible();
  await expect(tablet.getByRole('listitem').filter({ hasText: 'Check-up' })).toBeVisible();
  await tablet.goBack();
  await tablet.getByRole('button', { name: /Clinic hours/ }).click();
  const tabletSaturday = tablet.getByRole('group', { name: 'Saturday' }).first();
  await expect(tabletSaturday.getByRole('button', { name: 'Closed' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('the app is in Amharic by default', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'በዚህ ስልክ ይግቡ' })).toBeVisible();
});
