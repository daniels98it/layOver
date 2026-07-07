/* Layover service worker — caches the whole app so it runs with zero network.
   Bump CACHE_VERSION whenever you edit any file, so installed phones update.
   (The HTML is served network-first, so content updates even without a bump —
   but bumping still guarantees a clean re-install of every cached asset.) */
const CACHE_VERSION = "layover-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* Fetch strategy:
   • HTML / navigations → NETWORK-FIRST. When online you always get the freshly
     deployed page (and we refresh the cache copy); offline falls back to cache.
     This is what lets an installed PWA pick up new deploys on its own.
   • Everything else (icons, manifest) → CACHE-FIRST for instant, offline load. */
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const accept = req.headers.get("accept") || "";
  const isHTML = req.mode === "navigate" || accept.includes("text/html");

  if (isHTML) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // Clone synchronously — the body can only be read once.
          const copyForReq = res.clone();
          const copyForIndex = res.clone();
          caches.open(CACHE_VERSION).then((c) => {
            c.put(req, copyForReq);
            c.put("./index.html", copyForIndex);  // keep the offline fallback current
          });
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: true })
            .then((cached) => cached || caches.match("./index.html"))
        )
    );
    return;
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
