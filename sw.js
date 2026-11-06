// Offline support: cache the app shell so it opens with no connection.
const CACHE = "tote-qr-v1";
const SHELL = [
  "./", "./index.html", "./app.js", "./manifest.webmanifest",
  "./lib/qrcode.js", "./lib/jsQR.js", "./lib/fflate.js",
  "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // Any page request (e.g. a scanned QR link with ?tote=...) gets the app shell
  if (e.request.mode === "navigate") {
    e.respondWith(caches.match("./index.html").then((r) => r || fetch(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
