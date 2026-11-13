/* Roundcast service worker — 라운드 날씨 알림 전용 (캐시 없음) */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: "Roundcast", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Roundcast", {
    body: d.body || "", icon: "/icon-192.png", badge: "/favicon-48.png", tag: d.tag || "roundcast", data: { url: d.url || "https://roundcast.kr/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "https://roundcast.kr/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if (c.url.startsWith("https://roundcast.kr") && "focus" in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
