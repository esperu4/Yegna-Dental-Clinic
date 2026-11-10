/// <reference lib="webworker" />
/**
 * The service worker (PRD §7.3, M2): keeps the app shell for offline use and syncs with the app
 * closed.
 * - install: caches every file of this build (the list is written in at build time);
 * - fetch: serves the app from that cache (offline included); API calls are not touched;
 * - sync ('outbox') and periodicsync ('yegna-sync'): runs the same sync engine as the page;
 * - notificationclick: opens or focuses the app.
 * Built separately into /sw.js by build/serviceWorker.ts.
 */
import { db } from './lib/db.ts';
import { session } from './lib/session.ts';
import { OUTBOX_SYNC_TAG, PERIODIC_SYNC_TAG, sync } from './lib/sync.ts';
import type { notificationTarget } from './lib/syncStatus.ts';

declare const self: ServiceWorkerGlobalScope;
declare const __PRECACHE_FILES__: string[];
declare const __SW_VERSION__: string;

const CACHE_PREFIX = 'yegna-shell-';

/**
 * A response the browser will accept for a navigation. A host may answer `/index.html` with a
 * redirect to `/` (Cloudflare does): a cached response marked "redirected" is refused for
 * navigations and the app would not open, so keep a plain copy.
 */
async function storable(response: Response): Promise<Response> {
  if (!response.redirected) return response;
  return new Response(await response.blob(), { status: response.status, headers: response.headers });
}
const CACHE = `${CACHE_PREFIX}${__SW_VERSION__}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const file of __PRECACHE_FILES__) {
        // Straight from the server (not the HTTP cache), so this build's files are what is kept.
        const response = await fetch(new Request(file, { cache: 'reload' }));
        if (!response.ok) throw new Error(`precache failed: ${file} ${response.status}`);
        await cache.put(file, await storable(response));
      }
      // The new version takes over at once; open pages keep the code they already loaded.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Only this app's own files; the API (another origin) always goes to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // The app routes on the hash, so every page is index.html.
      // Match on the URL only: hosts may send `Vary: Origin`, and the page loads its scripts with
      // an Origin header the precache requests did not have. These are our own static files.
      const cached = await cache.match(request.mode === 'navigate' ? '/' : request, {
        ignoreSearch: true,
        ignoreVary: true,
      });
      return cached ?? fetch(request);
    })(),
  );
});

// --- Sync with the app closed -------------------------------------------------------------

/**
 * One sync run. Throws while work remains (still offline, server error, ops left in the outbox),
 * so the browser tries the 'sync' again later. Ops held back by the daily budget wait for the
 * app or the periodic sync instead.
 */
async function runSync({ outboxOnly }: { outboxOnly: boolean }): Promise<void> {
  // Re-read the stored session every time: the page may have signed out or re-enrolled since.
  // Not counted as use, so a background sync never keeps the 24 h lock away.
  await session.init({ use: false });
  if (!session.current.value) return;
  await sync.refresh();
  // An outbox sync with nothing to send (the open app already sent it) costs no request.
  if (outboxOnly && ((await db.outbox.count()) === 0 || sync.heldUntil.value !== null)) return;
  await sync.syncNow();
  if (sync.state.value === 'offline' || sync.state.value === 'error') throw new Error('sync not done');
  if (session.current.value && sync.heldUntil.value === null && (await db.outbox.count()) > 0) {
    throw new Error('ops still waiting');
  }
}

self.addEventListener('sync', (event) => {
  const e = event as ExtendableEvent & { tag: string };
  if (e.tag === OUTBOX_SYNC_TAG) e.waitUntil(runSync({ outboxOnly: true }));
});

self.addEventListener('periodicsync', (event) => {
  const e = event as ExtendableEvent & { tag: string };
  // Best effort: a failed periodic run is simply tried at the next interval.
  if (e.tag === PERIODIC_SYNC_TAG) e.waitUntil(runSync({ outboxOnly: false }).catch(() => undefined));
});

/**
 * Where a notification opens (PRD §7.7). Bookings to fix and new bookings to approve are both on
 * the Today view (its "Needs attention" list and the cards); there is no separate screen yet.
 */
function urlFor(_target: ReturnType<typeof notificationTarget>): string {
  return '/';
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data as { target?: ReturnType<typeof notificationTarget> } | null)
    ?.target;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows[0];
      if (open) await open.focus();
      else await self.clients.openWindow(urlFor(target ?? 'today'));
    })(),
  );
});
