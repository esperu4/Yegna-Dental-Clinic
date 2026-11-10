/**
 * Offline after enrolment (PRD §19, M2): the app opens with no network from the service worker's
 * cache, shows the working copy, takes bookings into the outbox, and sends them when back online.
 */
import { expect, test } from '@playwright/test';
import { doctorPhone, openDay } from '../e2e/helpers.ts';

test('works completely offline after enrolment, and syncs when back online', async ({ page, context }) => {
  // A patient of its own, so repeated runs against the same database don't see each other.
  const digits = String(Date.now()).slice(-6);
  const name = `Offline Test ${digits}`;
  const phone = `0914${digits}`;
  await doctorPhone(page, 'Offline phone');
  // The sheet opens at the next free time; if that is lunch, book anyway.
  page.on('dialog', (d) => void d.accept());
  // The service worker installs on the first visit and takes control of the page.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 30_000,
  });

  // A booking made online, so the working copy has something to show offline.
  await openDay(page, 1);
  await page.getByRole('button', { name: 'New booking' }).click();
  await page.getByLabel('Phone').fill(phone);
  await page.getByLabel('Patient name').fill(name);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.booking').filter({ hasText: name }).getByText('Approved')).toBeVisible({
    timeout: 15_000,
  });

  // No network at all: the app still opens (cold start from the cache).
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(page.locator('.sync-pill')).toHaveText(/Offline since/);
  await openDay(page, 1);
  await expect(page.locator('.booking').filter({ hasText: name })).toBeVisible();

  // Book a returning patient offline: searched on the device, queued in the outbox.
  await page.getByRole('button', { name: 'New booking' }).click();
  await page.getByLabel('Phone').pressSequentially(phone.slice(0, 7));
  await page
    .getByRole('list', { name: 'Matching patients' })
    .getByRole('button', { name: new RegExp(name) })
    .click();
  await page.getByRole('button', { name: 'Save' }).click();
  const offlineBooking = page
    .locator('.booking')
    .filter({ hasText: name })
    .filter({ hasText: 'Not sent yet' });
  await expect(offlineBooking).toHaveCount(1);
  await expect(page.locator('.sync-pill')).toHaveText(/Offline since/);

  // Reload while still offline: the outbox and the booking survive.
  await page.reload();
  await openDay(page, 1);
  await expect(
    page.locator('.booking').filter({ hasText: name }).filter({ hasText: 'Not sent yet' }),
  ).toHaveCount(1);

  // Back online: the booking is sent and accepted.
  await context.setOffline(false);
  await expect(page.locator('.sync-pill')).toHaveText('Synced', { timeout: 30_000 });
  await expect(
    page.locator('.booking').filter({ hasText: name }).filter({ hasText: 'Not sent yet' }),
  ).toHaveCount(0);
  await expect(page.locator('.booking').filter({ hasText: name }).getByText('Approved')).toHaveCount(2);
});

test('the service worker sends the outbox with the app closed (Background Sync, PRD §7.3)', async ({
  context,
}) => {
  const page = await context.newPage();
  page.on('dialog', (d) => void d.accept());
  const digits = String(Date.now()).slice(-6);
  const name = `Background ${digits}`;
  await doctorPhone(page, 'Background phone');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 30_000,
  });

  // Book offline: the page can't send it, so it asks for a Background Sync.
  await context.setOffline(true);
  await openDay(page, 2);
  await page.getByRole('button', { name: 'New booking' }).click();
  await page.getByLabel('Phone').fill(`0915${digits}`);
  await page.getByLabel('Patient name').fill(name);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.booking').filter({ hasText: name }).getByText('Not sent yet')).toBeVisible();

  // Close the app, then come back online with nothing of the app running but its service worker.
  // A static file of the same origin gives a page that can read the device store without app code.
  const probe = await context.newPage();
  await page.close();
  await context.setOffline(false);
  await probe.goto('/manifest.webmanifest');
  const outboxCount = () =>
    probe.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const open = indexedDB.open('yegna');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const req = open.result.transaction('outbox').objectStore('outbox').count();
            req.onsuccess = () => {
              open.result.close();
              resolve(req.result);
            };
          };
        }),
    );
  expect(await outboxCount()).toBeGreaterThan(0);

  // The browser fires the 'outbox' sync event (as it does when the network returns).
  const cdp = await context.newCDPSession(probe);
  const registration = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const r = registrations.find((x: { scopeURL: string; isDeleted: boolean }) => !x.isDeleted);
      if (r) resolve(r.registrationId);
    });
  });
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.dispatchSyncEvent', {
    origin: new URL(probe.url()).origin,
    registrationId: await registration,
    tag: 'outbox',
    lastChance: false,
  });
  await expect.poll(outboxCount, { timeout: 30_000 }).toBe(0);
});
