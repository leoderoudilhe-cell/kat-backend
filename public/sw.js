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
    data: { url: payload.url || '/' }
  };

  e.waitUntil(self.registration.showNotification(payload.title || 'KAT 🐱', opts));
});

// Handle notification click — open app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return clients.openWindow(e.notification.data?.url || '/');
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
