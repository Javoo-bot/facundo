self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let d = { title: "New order", body: "Open Facundo", url: "/florist" };
  try { d = { ...d, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(d.title, { body: d.body, icon: "/icons/icon-192.png", data: d.url }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data || "/florist"));
});
