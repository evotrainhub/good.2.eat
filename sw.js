/* Good.2.eat — service worker: aplicația se deschide repede și funcționează parțial fără internet.
   Schimbă VERSION la fiecare actualizare importantă, ca telefoanele să ia fișierele noi. */
const VERSION = "g2e-0.10.1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./privacy.html",
               "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];
const CDN = ["cdn.jsdelivr.net", "unpkg.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // paginile aplicației: întâi internetul (ca să vină mereu versiunea nouă), apoi copia salvată
  if (req.mode === "navigate" && url.origin === location.origin) {
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(VERSION).then(x => x.put(req, c)); return r; })
      .catch(() => caches.match(req).then(r => r || caches.match("./index.html"))));
    return;
  }
  // iconițe, manifest: din copie, actualizate în fundal
  if (url.origin === location.origin || CDN.includes(url.hostname)) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
  // restul (Open Food Facts, Worker-ul AI) trece direct, fără cache
});
