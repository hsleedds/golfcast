/* Roundcast service worker — 라운드 날씨 알림 + 미리 받은 골프장 지도(위성사진) 꺼내 쓰기
   지도는 사용자가 [지도 미리 받기]·[라운드 시작]을 눌렀을 때 화면 쪽에서 이 기기 Cache(rc-map-*)에 담아 둔 것만 씀.
   인터넷이 되면 늘 새로 받고, 안 될 때만 꺼내 씀. 여기서 저장하지 않고, 서버로 보내는 것도 없음. */
self.addEventListener("install", () => self.skipWaiting());
/* 예전 방식(rc-map-*)으로 받아 둔 지도는 잘못 저장된 빈 사진이 섞일 수 있어 지움 → 앱에서 새로(rc-map2-*) 받음 */
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("rc-map-")).map((k) => caches.delete(k))))
    .catch(() => {}).then(() => self.clients.claim())));
/* 인터넷 먼저(4초 안에 오면 그걸 씀) → 안 되면 미리 받아 둔 것 */
/* 위성사진: 먼저 cors로 받아 오류(403·500 등)를 알아볼 수 있게 함. 오류면 미리 받아 둔 사진, 그것도 없으면 그대로 */
let corsOK = true;
function tileFirst(req) {
  const u = req.url;
  const cached = () => caches.match(u, { ignoreVary: true });
  const net = new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error("timeout")), 5000);
    const go = (mode) => fetch(u, { mode, credentials: "omit" });
    (corsOK ? go("cors").catch((err) => { if (navigator.onLine !== false) { corsOK = false; return go("no-cors"); } throw err; }) : go("no-cors"))
      .then((r) => { clearTimeout(t); (r.ok || r.type === "opaque") ? ok(r) : no(new Error("bad " + r.status)); }, (err) => { clearTimeout(t); no(err); });
  });
  return net.catch(() => cached().then((r) => r || fetch(req)));
}
function netFirst(req, opt) {
  const net = new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error("timeout")), 4000);
    fetch(req).then((r) => { clearTimeout(t); (r.ok || r.type === "opaque") ? ok(r) : no(new Error("bad " + r.status)); }, (err) => { clearTimeout(t); no(err); });
  });
  return net.catch(() => caches.match(req.url, opt).then((r) => r || fetch(req)));
}
self.addEventListener("fetch", (e) => {
  const u = e.request.url;
  if (e.request.method === "GET" && u.startsWith(self.location.origin + "/elev/")) { /* 미리 받은 골프장 높이 파일 */
    e.respondWith(netFirst(e.request, { ignoreSearch: true }));
    return;
  }
  if (e.request.method !== "GET" || !u.startsWith("https://api.vworld.kr/req/wmts/") || !u.includes("/Satellite/")) return;
  e.respondWith(tileFirst(e.request));
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
