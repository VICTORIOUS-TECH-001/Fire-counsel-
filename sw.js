const CACHE_NAME = "fire-counsel-shell-v42";
const APP_CACHE_PREFIX = "fire-counsel-shell-";
const APP_SHELL = [
  "./", "./index.html", "./study.html", "./ai.html",
  "./site.css", "./home-hero.css", "./home-learning.css", "./home-ai.css", "./home-case-video.css", "./home-ending.css", "./home-ending.mjs", "./branding.css", "./site.js", "./home-hero.mjs", "./home-ai.mjs", "./home-ai-access.mjs", "./homepage-copy.mjs", "./homepage-media.mjs", "./home-case-video.mjs", "./styles.css", "./app.js", "./integrations.css",
  "./study-materials.mjs", "./research-search.mjs", "./student-profile.mjs", "./student-page.mjs", "./installation.mjs", "./request-scope.mjs", "./auth-gate.mjs",
  "./ai-studio.css", "./ai-page.css", "./ai-studio.mjs", "./ai-markdown.mjs", "./presence.mjs", "./pdf-reader.mjs",
  "./preloader.css", "./preloader.js", "./workspace.css", "./workspace.mjs", "./workspace-config.mjs",
  "./data/site-content.json", "./manifest.webmanifest",
  "./assets/fire-counsel-192.png", "./assets/fire-counsel-512.png",
  "./assets/images/fire-counsel-flame.png", "./assets/images/pexels-law-judge.jpg",
  "./assets/images/workspace-hero.jpg", "./assets/images/workspace-quote.jpg"
];
const SHELL_PATHS = new Set(APP_SHELL.map(path => new URL(path, self.location.href).pathname));
// The PDF engine is cached the first time a student opens a PDF (not at
// install: static copies of the site do not have it), so saved PDFs open offline.
const RUNTIME_PATHS = new Set(["/vendor/pdfjs/build/pdf.min.mjs", "/vendor/pdfjs/build/pdf.worker.min.mjs"]);

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
  const url = new URL(request.url);
  // Never cache authenticated replies, runtime Firebase config, admin pages, or
  // arbitrary same-origin responses. Only the explicit public/study shell is cached.
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname === "/api" || url.pathname.startsWith("/api/") || request.headers.has("authorization") || request.cache === "no-store" || !(SHELL_PATHS.has(url.pathname) || RUNTIME_PATHS.has(url.pathname))) return;

  async function updateFromNetwork() {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === "basic") {
      const cache = await caches.open(CACHE_NAME);
      // Query strings must not grow the app cache without bound.
      await cache.put(url.pathname, response.clone());
    }
    return response;
  }

  event.respondWith((async () => {
    const cached = await caches.match(url.pathname);
    // HTML and homepage content get fresh edits online. Offline requests fall
    // back to their own cached document, never HTML masquerading as JavaScript.
    const networkFirst = request.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname.endsWith(".json");
    if (cached && !networkFirst) return cached;
    try {
      return await updateFromNetwork();
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
  })());
});
