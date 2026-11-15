const CACHE_NAME = "fire-counsel-shell-v6";
const APP_CACHE_PREFIX = "fire-counsel-shell-";
const APP_SHELL = [
  "./", "./index.html", "./study.html",
  "./site.css", "./site.js", "./styles.css", "./app.js",
  "./data/site-content.json", "./manifest.webmanifest",
  "./assets/fire-counsel-192.png", "./assets/fire-counsel-512.png",
  "./assets/images/fire-counsel-brand.jpg", "./assets/images/pexels-law-judge.jpg", "./assets/images/pexels-law-student.jpg"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  // Remove only older FIRE COUNSEL app-shell caches. Never clear IndexedDB or localStorage.
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith(APP_CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(request).then(cached => {
    if (cached) return cached;
    return fetch(request).then(response => {
      if (response && response.status === 200 && response.type === "basic") {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match("./index.html"));
  }));
});
