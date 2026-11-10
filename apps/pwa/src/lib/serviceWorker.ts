/**
 * Registers the service worker (production builds only; development runs without one) and asks
 * for periodic sync about every 12 hours where the browser grants it (PRD §7.3, best effort).
 */
import { db } from './db.ts';
import { PERIODIC_SYNC_MS, PERIODIC_SYNC_TAG } from './sync.ts';

type PeriodicSyncRegistration = ServiceWorkerRegistration & {
  periodicSync?: { register(tag: string, options: { minInterval: number }): Promise<void> };
};

/**
 * A new version took over (a deploy): reload into it the next time the app is not on screen, so
 * no one loses what they are typing. The outbox and working copy are on the device and survive.
 */
function reloadIntoNewVersion(): void {
  let pending = false;
  const reloadWhenHidden = () => {
    if (document.visibilityState === 'hidden') location.reload();
    else pending = true;
  };
  document.addEventListener('visibilitychange', () => {
    if (pending && document.visibilityState === 'hidden') location.reload();
  });
  navigator.serviceWorker.addEventListener('controllerchange', reloadWhenHidden);
  // A newer version upgraded the device store: this page can no longer use it, so reload now
  // (everything is on the device; at worst a half-typed form is lost).
  db.on('versionchange', () => {
    db.close();
    location.reload();
    return false;
  });
}

export async function registerServiceWorker(): Promise<void> {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const hadController = navigator.serviceWorker.controller !== null;
  try {
    const registration = (await navigator.serviceWorker.register('/sw.js')) as PeriodicSyncRegistration;
    // The very first install also "changes" the controller; only later versions need a reload.
    if (hadController) reloadIntoNewVersion();
    if (!registration.periodicSync) return;
    const permission = await navigator.permissions.query({
      name: 'periodic-background-sync' as PermissionName,
    });
    if (permission.state === 'granted') {
      await registration.periodicSync.register(PERIODIC_SYNC_TAG, { minInterval: PERIODIC_SYNC_MS });
    }
  } catch {
    // The app works without a service worker (online only); nothing to show the user.
  }
}
