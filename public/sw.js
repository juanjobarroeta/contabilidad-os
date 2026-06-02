// Minimal service worker — enables PWA installability without aggressive
// caching. For a financial app we deliberately do NOT cache app pages or API
// responses (stale balances/CFDIs would be dangerous). It's network-first and
// only serves a tiny offline fallback when the network is unavailable.

const OFFLINE_URL = "/offline.html";
const CACHE = "contaos-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([OFFLINE_URL, "/icons/icon-192.png"]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle top-level navigations; let everything else hit the network
  // normally (no caching of API/data).
  if (req.mode !== "navigate") return;
  event.respondWith(
    fetch(req).catch(() => caches.match(OFFLINE_URL))
  );
});
