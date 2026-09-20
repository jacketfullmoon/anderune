// Minimal service worker. iOS only allows web notifications through one of these,
// and it's also what a real push server would talk to later.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('./');
  })());
});

// If push is ever wired up to a server, this is where it arrives.
self.addEventListener('push', (event) => {
  let data = { title: 'Anderune', body: 'Someone wants you.' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: data.tag || 'anderune',
  }));
});
