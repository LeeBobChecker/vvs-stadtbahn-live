/**
 * Service Worker: macht die App offline-faehig und beschleunigt
 * Wiederbesuche. App-Shell + Fahrplandaten werden gecacht und im
 * Hintergrund aktualisiert; Kartenkacheln bleiben ungecacht.
 */

"use strict";

const CACHE = "stadtbahn-v8";
const SHELL = [
  "index.html",
  "css/style.css?v=8",
  "js/datasource.js?v=8",
  "js/app.js?v=8",
  "data/network.json",
  "data/schedule.json",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      // cache: "reload" umgeht den HTTP-Cache des Browsers, damit beim
      // Installieren garantiert der aktuelle Stand geladen wird
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Kartenkacheln nicht cachen (zu viele, Netz ist ohnehin noetig)
  if (url.hostname.endsWith("cartocdn.com")) return;

  // Seitenaufrufe: erst Netz (damit Updates ankommen), sonst Cache.
  // cache: "no-cache" zwingt zur Revalidierung beim Server — sonst wuerde
  // "Netz" still aus dem HTTP-Cache des Browsers bedient.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req.url, { cache: "no-cache" })
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("index.html", copy));
          return res;
        })
        .catch(() => caches.match("index.html"))
    );
    return;
  }

  // Alles andere: Cache zuerst, parallel im Hintergrund frisch nachladen
  e.respondWith(
    caches.match(req).then((cached) => {
      const fresh = fetch(req.url, { cache: "no-cache" })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
