// ═══ KAT Service Worker — Web Push Handler ═══
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });

// Handle incoming Web Push notifications
self.addEventListener('push', e => {
  if (!e.data) return;
  let payload;
  try { payload = e.data.json(); } catch { payload = { title: 'KAT 🐱', body: e.data.text() }; }

  // Push silencieux de sync — déclencher un sync dans toutes les fenêtres ouvertes
  if (payload.title === '__sync__') {
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'SYNC_NOW' }));
      })
    );
    return; // pas de notif visible
  }

  const opts = {
    body: payload.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: payload.tag || 'kat-notif',
    vibrate: [200, 100, 200, 100, 200],
    requireInteraction: payload.persist || false,
    // Stocke le message complet pour l'afficher dans l'app au clic
    data: { url: payload.url || '/', fullTitle: payload.title, fullBody: payload.body }
  };

  e.waitUntil(self.registration.showNotification(payload.title || 'KAT 🐱', opts));
});

// Handle notification click — open app + affiche le message complet
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { fullTitle, fullBody, url } = e.notification.data || {};
  const targetUrl = (fullBody ? `/?kat_msg=${encodeURIComponent(fullTitle||'')}__SEP__${encodeURIComponent(fullBody)}` : url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) {
        // Envoie le message à l'app ouverte via postMessage
        existing.postMessage({ type: 'SHOW_MSG', title: fullTitle, body: fullBody });
        return existing.focus();
      }
      return clients.openWindow(targetUrl);
    })
  );
});

// Handle messages from app
self.addEventListener('message', e => {
  if (e.data?.type === 'SCHEDULE_NOTIF') {
    const { title, body, delay, tag } = e.data;
    setTimeout(() => {
      self.registration.showNotification(title, {
        body, tag: tag || 'kat-local',
        icon: '/icon.svg', badge: '/icon.svg',
        vibrate: [200, 100, 200],
      });
    }, delay || 0);
  }
});
