// Service worker: push notifikace (Firebase Cloud Messaging) + ochrana proti
// zastaralé zacachované appce na iOS (network-first pro HTML/JS, cache-first
// pro statické soubory jako ikony/fonty).

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDnWBkXpnGCSPMKPrbroJtP2QVt48YtURw",
  authDomain: "kokrsnek-4bdc7.firebaseapp.com",
  projectId: "kokrsnek-4bdc7",
  storageBucket: "kokrsnek-4bdc7.firebasestorage.app",
  messagingSenderId: "1079843186893",
  appId: "1:1079843186893:web:b826958d3884ea34412184"
});

const messaging = firebase.messaging();
const CACHE = 'kokrsnek-static-v1';

// --- Push notifikace ---------------------------------------------------

messaging.onBackgroundMessage((payload) => {
  const title = (payload.data && payload.data.title) || 'KoKrŠNeK';
  const options = {
    body: (payload.data && payload.data.body) || '',
    icon: 'icon-192v2.png',
    badge: 'icon-192v2.png',
    data: payload.data || {}
  };
  self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('./index.html');
    })
  );
});

// --- Cachování: HTML vždy čerstvé ze sítě, statické soubory cache-first ---
// DŮLEŽITÉ: appka na iOS bez tohohle mívá tendenci držet si starou přidanou-na-plochu
// verzi napořád, i po nasazení oprav. Proto HTML/JS vždy jde přímo na síť.

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isHTML = event.request.destination === 'document' || url.pathname.endsWith('.html') || url.pathname === '/';

  if (isHTML) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, clone));
        return res;
      });
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
