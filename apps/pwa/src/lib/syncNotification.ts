/**
 * The sync notification (PRD §7.7): after a sync in which something happened,
 * "Synced: 3 bookings sent · 2 new from Hana · 1 clash to fix". Nothing when nothing changed, and
 * only when the app is not on screen (decided 2026-11-10; on screen, the pill shows the state).
 * Works from the page and from the service worker (with the app closed). Counts and staff names
 * only, never patient data.
 */
import { t } from '../i18n/index.ts';
import { db } from './db.ts';
import { session } from './session.ts';
import { type SyncSummary, notificationTarget } from './syncStatus.ts';

export async function summaryText(summary: SyncSummary): Promise<string> {
  const parts: string[] = [];
  if (summary.bookingsSent) {
    parts.push(t(summary.bookingsSent === 1 ? 'notify.sentOne' : 'notify.sent', { n: summary.bookingsSent }));
  }
  for (const [userId, n] of Object.entries(summary.fromOthers)) {
    const name = (await db.users.get(userId))?.name ?? '…';
    parts.push(t('notify.fromOthers', { n, name }));
  }
  if (summary.toFix) parts.push(t('notify.toFix', { n: summary.toFix }));
  return `${t('notify.title')}: ${parts.join(' · ')}`;
}

/** Inside the service worker: `self` is its global scope, with a registration and clients. */
function serviceWorkerScope(): ServiceWorkerGlobalScope | null {
  return typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope
    ? self
    : null;
}

/** Whether any window of the app is on screen right now. */
async function appOnScreen(): Promise<boolean> {
  const sw = serviceWorkerScope();
  if (sw) {
    const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    return windows.some((w) => w.visibilityState === 'visible');
  }
  return typeof document !== 'undefined' && document.visibilityState === 'visible';
}

export async function showSyncNotification(summary: SyncSummary): Promise<void> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (await appOnScreen()) return;
  const body = await summaryText(summary);
  const target = notificationTarget(summary, session.current.value?.user.role === 'doctor');
  const options: NotificationOptions = { body, tag: 'sync', icon: '/icons/icon-192.png', data: { target } };
  const sw = serviceWorkerScope();
  const registration = sw ? sw.registration : await navigator.serviceWorker?.getRegistration();
  if (registration) {
    await registration.showNotification(t('app.name'), options);
    return;
  }
  // No service worker (development): a page notification, where the browser allows one.
  try {
    new Notification(t('app.name'), options).onclick = () => window.focus();
  } catch {
    /* Android Chrome only allows notifications from a service worker */
  }
}
