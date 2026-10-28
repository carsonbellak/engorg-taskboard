const CACHE_NAME = 'engorg-v36';
// Holds what the Android share sheet sent (see the share-target handler below) until app.js
// picks it up, so it must survive the activate-time cache cleanup.
const SHARE_INBOX = 'engorg-share-inbox';
// VAPID public key — must match the value set in Firebase secrets and app.js
const VAPID_PUBLIC_KEY = 'BDmHi7C-yoOita_aL7JFADc18CiVCcn0Jw43XPIQZ_4Bu4J279M1PgRnktePqsJh_-UGkhikhwnnUOdUsBEeQhM';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.json'
];

// Install: cache app shell. Fetch each asset with {cache:'reload'} so the SW cache is
// populated from the network, never from a stale HTTP cache entry — otherwise a fresh
// deploy could still be cached over by the browser's 1-hour copy.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== SHARE_INBOX).map(k => caches.delete(k)))
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
    tag: data.tag || data.timerId || 'timer',
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
      return clients.openWindow(event.notification.data?.url || '/#timers');
    })
  );
});

// No signed-in user here, so the server matches the old endpoint to carry the uid over.
// Without this a rotated subscription would go silent until the PWA is next opened.
self.addEventListener('pushsubscriptionchange', event => {
  const oldEndpoint = event.oldSubscription && event.oldSubscription.endpoint;
  event.waitUntil(
    (event.newSubscription ? Promise.resolve(event.newSubscription) : self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: VAPID_PUBLIC_KEY
    })).then(sub =>
      fetch('/api/registerPushSubscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), oldEndpoint })
      })
    )
  );
});

// ===================== SHARE TARGET (Android share sheet) =====================
// manifest.json share_target POSTs title/text/url + files here. Hosting can't take a POST,
// so stash it all in SHARE_INBOX and hand the app a redirect; app.js consumeShareTarget()
// sends it to the user's Share inbox once signed in, then deletes the stash.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.origin !== self.location.origin || url.pathname !== '/share-target') return;
  event.respondWith((async () => {
    try {
      const form = await event.request.formData();
      const files = form.getAll('files').filter(f => f && typeof f !== 'string' && f.size > 0);
      await caches.delete(SHARE_INBOX);
      const cache = await caches.open(SHARE_INBOX);
      await Promise.all(files.map((f, i) => cache.put('/__share/file-' + i, new Response(f, {
        headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Name': encodeURIComponent(f.name || 'file') }
      }))));
      await cache.put('/__share/meta', new Response(JSON.stringify({
        title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', files: files.length
      }), { headers: { 'Content-Type': 'application/json' } }));
    } catch (e) { /* fall through: the app opens without a share */ }
    return Response.redirect('/?share-target=1', 303);
  })());
});

// ===================== FETCH (network-first caching) =====================

// Fetch: network-first for app files, skip for Firebase/Google
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return; // POSTs (API calls, share target) aren't cacheable

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
