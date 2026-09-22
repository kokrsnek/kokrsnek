// Service worker: push notifikace (Firebase Cloud Messaging) + ochrana proti
// zastaralé zacachované appce na iOS (network-first pro HTML/JS, cache-first
// pro statické soubory jako ikony/fonty).

// Push zprávu zpracováváme RUČNĚ přes syrovou 'push' událost (ne přes
// messaging.onBackgroundMessage z Firebase SDK) — ten totiž nezaručeně
// obaloval zobrazení notifikace do event.waitUntil(), takže si prohlížeč
// myslel, že se notifikace nezobrazila včas, a sám navíc přidal vlastní
// prázdnou "záložní" notifikaci → chodily tak dvě najednou.
const CACHE = 'kokrsnek-static-v1';

self.addEventListener('push', (event) => {
  let raw = {};
  try{
    raw = event.data ? event.data.json() : {};
  }catch(e){}

  // Firebase může doručit data v mírně jiné struktuře podle verze/cesty doručení
  // (vnořené pod "data", nebo přímo na kořeni) — zkusíme obojí, ať appka nespadne
  // na prázdný výchozí text.
  const nested = raw && typeof raw.data === 'object' ? raw.data : {};
  const title = nested.title || raw.title || 'KoKrŠNeK';
  const body = nested.body || raw.body || '';

  const options = {
    body,
    icon: 'icon-192v2.png',
    badge: 'icon-badge.png',
    data: nested.title || nested.body ? nested : raw
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // eventId otevře appku rovnou na kartě té akce, chatWith rovnou na dané vlákno
  // v minichatu, pollId rovnou na danou anketu, bringKey rovnou na "Kdo co
  // přinese" dané akce — všechno čteme z data payloadu notifikace.
  const eventId = event.notification.data && event.notification.data.eventId;
  const chatWith = event.notification.data && event.notification.data.chatWith;
  const pollId = event.notification.data && event.notification.data.pollId;
  const bringKey = event.notification.data && event.notification.data.bringKey;
  const expenseKey = event.notification.data && event.notification.data.expenseKey;
  let targetUrl = './index.html';
  if (eventId) targetUrl = `./index.html?event=${encodeURIComponent(eventId)}`;
  else if (chatWith) targetUrl = `./index.html?chat=${encodeURIComponent(chatWith)}`;
  else if (pollId) targetUrl = `./index.html?poll=${encodeURIComponent(pollId)}`;
  else if (bringKey) targetUrl = `./index.html?bring=${encodeURIComponent(bringKey)}`;
  else if (expenseKey) targetUrl = `./index.html?expense=${encodeURIComponent(expenseKey)}`;

  // ZÁLOHA PRO iOS: Safari appku po klepnutí na notifikaci skoro vždycky
  // "zabitou" na pozadí jen znovu spustí, a přitom dlouhodobě (a bez opravy
  // od Applu) ignoruje URL předanou přes clients.openWindow()/navigate() —
  // appka se pak otevře jen na výchozí obrazovce. Proto si servisní
  // pracovník cílovou akci navíc uloží do IndexedDB, a appka si ji po
  // startu sama vyzvedne (viz idbGetPendingNav v index.html), místo aby se
  // spoléhala jen na URL parametr.
  const idbSetPendingNav = (eventId || chatWith || pollId || bringKey || expenseKey) ? new Promise((resolve) => {
    try{
      const req = indexedDB.open('kokrsnekNav', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('pending'); };
      req.onsuccess = () => {
        try{
          const tx = req.result.transaction('pending', 'readwrite');
          tx.objectStore('pending').put({ eventId, chatWith, pollId, bringKey, expenseKey, at: Date.now() }, 'latest');
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        }catch(e){ resolve(); }
      };
      req.onerror = () => resolve();
    }catch(e){ resolve(); }
  }) : Promise.resolve();

  event.waitUntil(
    idbSetPendingNav.then(() => clients.matchAll({ type: 'window', includeUncontrolled: true })).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          // Appka už běží: pošli jí zprávu (pro případ, že poslouchá) a zkus i tvrdou
          // navigaci na cílovou URL, ať se to otevře spolehlivě i bez zprávy.
          if ((eventId || chatWith || pollId || bringKey || expenseKey) && 'postMessage' in client) {
            try {
              if (eventId) client.postMessage({ type: 'open-event', eventId });
              else if (chatWith) client.postMessage({ type: 'open-chat', chatWith });
              else if (pollId) client.postMessage({ type: 'open-poll', pollId });
              else if (bringKey) client.postMessage({ type: 'open-bring', bringKey });
              else client.postMessage({ type: 'open-expense', expenseKey });
            } catch (e) {}
          }
          if ((eventId || chatWith || pollId || bringKey || expenseKey) && 'navigate' in client) {
            return client.navigate(targetUrl).then((c) => (c || client).focus()).catch(() => client.focus());
          }
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
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
