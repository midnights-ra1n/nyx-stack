// Nyx service worker. It makes the app installable and lets the shell open with
// a bad connection. It caches code only: /api answers are personal and must
// always be live, so they are never stored on the device.
const CACHE = "nyx-shell-v1"
const MAX_ENTRIES = 80

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add("/")).then(() => self.skipWaiting()))
})

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

async function remember(req, res) {
  const cache = await caches.open(CACHE)
  await cache.put(req, res)
  const keys = await cache.keys()
  // Hashed bundles pile up across upgrades; insertion order drops the oldest.
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)).map((k) => cache.delete(k)))
}

async function networkFirst(req, fallback) {
  try {
    const res = await fetch(req)
    if (res.ok) await remember(req, res.clone())
    return res
  } catch {
    return (await caches.match(req)) ?? (await caches.match(fallback)) ?? Response.error()
  }
}

async function cacheFirst(req) {
  const hit = await caches.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) await remember(req, res.clone())
  return res
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== "GET" || url.origin !== location.origin) return
  if (/^\/(api|agent|mcp|hooks|install\.sh)/.test(url.pathname)) return
  if (url.pathname.startsWith("/assets/")) e.respondWith(cacheFirst(e.request)) // hashed, immutable
  else e.respondWith(networkFirst(e.request, "/"))
})
