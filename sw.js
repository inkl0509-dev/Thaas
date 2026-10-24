// THAAS service worker: only shows push notifications (it never caches the game, so updates are instant).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { notification: { body: e.data && e.data.text() } }; }
  const n = p.notification || {}, d = p.data || {};
  const title = n.title || d.title || "THAAS";
  e.waitUntil(self.registration.showNotification(title, {
    body: n.body || d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: d.tag || (d.kind === "update" ? "thaas-update" : (d.roomId || "thaas") + "-" + (d.kind || "")),
    data: d,
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  const url = d.kind === "update" ? "/?v=" + (d.version || Date.now()) : d.roomId ? "/?push=" + encodeURIComponent(d.roomId) : "/";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) { c.postMessage({ thaasPush: d }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
