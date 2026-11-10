/**
 * The sync notification (PRD §7.7): after a sync in which something happened,
 * "Synced: 3 bookings sent · 2 new from Hana · 1 clash to fix". Nothing when nothing changed.
 * Uses the service worker's registration when there is one (it also works with the app closed,
 * M2 slice 2), otherwise a page notification. Names only, never patient data.
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

export async function showSyncNotification(summary: SyncSummary): Promise<void> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  // Only when the app is not on screen (decided 2026-11-10): while it is, the pill shows the state.
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
  const body = await summaryText(summary);
  const target = notificationTarget(summary, session.current.value?.user.role === 'doctor');
  const options: NotificationOptions = { body, tag: 'sync', data: { target } };
  const registration = await navigator.serviceWorker?.getRegistration();
  if (registration) await registration.showNotification(t('app.name'), options);
  else {
    // Android Chrome only allows notifications from a service worker; elsewhere a page one works.
    try {
      new Notification(t('app.name'), options).onclick = () => window.focus();
    } catch {
      /* not allowed here */
    }
  }
}
