const CACHE_NAME = 'engorg-v15';
// VAPID public key — must match the value set in Firebase secrets and app.js
const VAPID_PUBLIC_KEY = 'BDmHi7C-yoOita_aL7JFADc18CiVCcn0Jw43XPIQZ_4Bu4J279M1PgRnktePqsJh_-UGkhikhwnnUOdUsBEeQhM';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.json'
];

// Install: cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ===================== PUSH NOTIFICATIONS =====================

self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Timer Done';
  const options = {
    body: data.body || 'Your timer has finished.',
    icon: '/icon-192.svg',
    badge: '/icon-192.svg',
    tag: data.timerId || 'timer',
    renotify: false,
    requireInteraction: true,
    data: { timerId: data.timerId, url: data.url || '/' },
    // Note: iOS 16.4+ supports Web Push but does not show notification action buttons.
    // The Dismiss button will appear on macOS and Android; on iOS the tap still works.
    actions: [{ action: 'dismiss', title: 'Dismiss' }]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') {
    const timerId = event.notification.data?.timerId;
    if (timerId) {
      event.waitUntil(
        fetch('/api/dismissTimer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timerId })
        }).catch(() => {})
      );
    }
    return;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('/#timers');
    })
  );
});

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: VAPID_PUBLIC_KEY
    }).then(sub =>
      fetch('/api/registerPushSubscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() })
      })
    )
  );
});

// ===================== FETCH (network-first caching) =====================

// Fetch: network-first for app files, skip for Firebase/Google
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go to network for Firebase/Google APIs
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('google.com')) {
    return;
  }

  // Network-first: try network, fall back to cache
  event.respondWith(
    fetch(event.request).then(response => {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      return response;
    }).catch(() => caches.match(event.request))
  );
});
