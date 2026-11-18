/* Roundcast service worker — 라운드 날씨 알림 + 미리 받은 골프장 지도(위성사진) 꺼내 쓰기
   지도는 사용자가 [지도 미리 받기]·[라운드 시작]을 눌렀을 때 화면 쪽에서 이 기기 Cache(rc-map-*)에 담아 둔 것만 씀.
   여기서는 새로 받거나 저장하지 않고, 서버로 보내는 것도 없음. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = e.request.url;
  if (e.request.method !== "GET" || !u.startsWith("https://api.vworld.kr/req/wmts/") || !u.includes("/Satellite/")) return;
  e.respondWith(caches.match(u, { ignoreVary: true }).then((r) => r || fetch(e.request)).catch(() => fetch(e.request)));
});
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
