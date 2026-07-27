const CACHE = "switchyard-mobile-v56";
const ASSETS = ["/", "/app.js?v=56", "/styles.css?v=56", "/manifest.webmanifest"];
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
  if (event.request.method === "GET") event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
