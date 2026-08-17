const CACHE = "switchyard-mobile-v91";
const ASSETS = ["/", "/app.js?v=91", "/styles.css?v=91", "/structured-notification.mjs?v=91", "/manifest.webmanifest"];
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});
self.addEventListener("activate", (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith("switchyard-mobile-") && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim())
));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // API、SSE 与配对请求直接放行，不进入缓存逻辑。
  if (url.pathname.startsWith("/mobile/")) return;
  // 带版本号的静态资源按版本缓存：版本升级时 activate 整体换缓存，命中即可直接返回。
  if (url.search.includes("v=")) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
      return response;
    })));
    return;
  }
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
