// Service worker POUZE pro push notifikace (Firebase Cloud Messaging).
// Záměrně NEDĚLÁ žádné cachování souborů ani network-first/cache-first logiku —
// appka dřív měla problémy se starou zacachovanou verzí na iOS, takže tenhle SW
// se do souborů appky vůbec neplete, jen čeká na push zprávy na pozadí.

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

// Appka je zavřená / na pozadí — zobraz systémovou notifikaci
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'KoKrŠNeK';
  const options = {
    body: (payload.notification && payload.notification.body) || '',
    icon: 'icon-192v2.png',
    badge: 'icon-192v2.png',
    data: payload.data || {}
  };
  self.registration.showNotification(title, options);
});

// Klik na notifikaci -> otevři appku (nebo přepni na už otevřenou záložku)
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

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
