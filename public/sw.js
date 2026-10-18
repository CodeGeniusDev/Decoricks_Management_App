/*
 * Decoricks service worker — Phase 9, Step 3: push + versioned offline shell.
 *
 * Caching model (design doc §5, three zones):
 *   1. PRECACHED SHELL  — `decoricks-shell-v{n}`: offline fallback page, login
 *      HTML, manifest and brand assets, written on `install`.
 *   2. RUNTIME (stale-while-revalidate) — navigational HTML of visited screens
 *      (`decoricks-pages-v{n}`) and content-hashed `/_next/static/*` (immutable
 *      by construction, safe to keep forever).
 *   3. NEVER CACHED — every `/api/*` response and every non-GET request. The
 *      fetch handler bypasses all caches for them outright: a stale financial
 *      read or a replayed write is the two failure modes the brief forbids,
 *      and offline API calls must fail fast so the queue path owns them.
 *
 * Update safety: NO auto-`skipWaiting` — a new worker writes its fresh shell
 * cache, posts `UPDATE_READY`, and waits; the UI prompt (or a refresh) posts
 * `SKIP_WAITING` for a controlled swap. `activate` deletes every older
 * `decoricks-*` cache, so a redeploy can never serve half-swapped versions.
 *
 * Offline queue: the worker does NOT run the sync engine — CSRF-token and
 * page-context rules keep that client-side. It only relays the browser's
 * best-effort Background Sync fire as `DRAIN_QUEUE` to an open tab.
 *
 * This file is plain JS (served verbatim from /public), so it uses no imports.
 */

// Bump the trailing number on every deploy that changes the shell set.
// `activate` treats any cache name not in the current family as stale.
const VERSION = 'phase9-offline-v1'
const SHELL_CACHE = 'decoricks-shell-v1'
const PAGES_CACHE = 'decoricks-pages-v1'
const STATIC_CACHE = 'decoricks-static-v1'
const CURRENT_CACHES = [SHELL_CACHE, PAGES_CACHE, STATIC_CACHE]

// Shell precache: static assets batch in; the dynamic login HTML is fetched
// separately so a failure there cannot abort the whole install.
const SHELL_ASSETS = [
  '/offline.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon.svg',
  '/maskable-icon.svg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      await cache.addAll(SHELL_ASSETS)
      // Login page offline-open needs an authed-less HTML shell; failure here
      // is tolerable (the offline fallback page covers navigation misses).
      await fetch('/login', { cache: 'reload' })
        .then((res) => res.ok && cache.put('/login', res))
        .catch(() => undefined)

      // If this is an UPDATE (a previous worker already controls the app),
      // tell open tabs a new version is waiting instead of force-swapping.
      const controlled = await self.clients.matchAll({ includeUncontrolled: false })
      for (const client of controlled) {
        client.postMessage({ type: 'UPDATE_READY', version: VERSION })
      }
    })()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Purge every older `decoricks-*` versioned cache — the belt-and-
      // suspenders "redeploy without cache" convention (design §5).
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k.startsWith('decoricks-') && !CURRENT_CACHES.includes(k))
          .map((k) => caches.delete(k))
      )
      await self.clients.claim()
    })()
  )
})

/* --------------------------------- fetch ---------------------------------- */

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  // Only same-origin GETs are candidates for any caching at all.
  if (url.origin !== self.location.origin || request.method !== 'GET') return

  // ZONE 3 — API never cached, fallback never served. Financial reads and
  // writes go straight to the network; offline they reject, which the queue
  // and the offline banner handle (§5/§6).
  if (url.pathname.startsWith('/api/')) return

  // Next.js client-side navigations fetch RSC payloads (`?_rsc=` / `RSC`
  // header). They are app data, must never be served stale, and their
  // cache-busting query tokens would only grow our caches. Network, always.
  if (url.searchParams.has('_rsc') || request.headers.get('RSC') === '1') return

  // ZONE 2a — content-hashed build assets: cache-first, immutable by name.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request, STATIC_CACHE))
    return
  }

  // ZONE 2b — document navigations: stale-while-revalidate with the offline
  // fallback page so an unreachable screen is a message, never a white page.
  if (request.mode === 'navigate') {
    event.respondWith(navigateWithFallback(request))
    return
  }

  // Everything else same-origin (manifest, icons, fonts): cache-first.
  event.respondWith(cacheFirst(request, SHELL_CACHE))
})

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request, { ignoreSearch: true })
  if (hit) {
    // Background revalidation keeps even cache hits eventually fresh (SWR).
    fetch(request)
      .then((res) => res.ok && cache.put(request, res))
      .catch(() => undefined)
    return hit
  }
  const res = await fetch(request)
  if (res.ok) cache.put(request, res.clone())
  return res
}

async function navigateWithFallback(request) {
  const cache = await caches.open(PAGES_CACHE)
  const hit = await cache.match(request, { ignoreSearch: true })
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone())
      return res
    })
    .catch(() => undefined)

  if (hit) return hit // revalidation already fired above; serve instantly
  const res = await network
  if (res) return res
  // Offline and never visited: controlled fallback page, never a white screen.
  const fallback =
    (await caches.match('/offline.html')) ?? (await fetch('/offline.html'))
  return new Response(await fallback.text(), {
    status: 503,
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
  })
}

/* ------------------------- background sync relay ---------------------------- */

// Best-effort (Android/desktop Chrome; silently unavailable on iOS). The tag
// is what `enqueueCreate` registers via `registration.sync.register`.
self.addEventListener('sync', (event) => {
  if (event.tag !== 'decoricks-drain') return
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window' })
      for (const client of clientList) {
        client.postMessage({ type: 'DRAIN_QUEUE' })
      }
    })()
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }

  const title = payload.title || 'Decoricks'
  const options = {
    body: payload.body || '',
    // Dedupe key: the server-supplied notification `_id`. Re-delivery of the same
    // event, or the same event observed by several open tabs, shows once.
    tag: payload.notificationId || 'decoricks',
    icon: '/icon.svg',
    badge: '/maskable-icon.svg',
    timestamp: Date.now(),
    data: {
      link: payload.link || '/',
      notificationId: payload.notificationId || null,
      type: payload.type || null,
    },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const rawLink = (event.notification.data && event.notification.data.link) || '/'
  // Resolve against the SW origin so a deep link like `/finance?transaction=…`
  // becomes an absolute URL we can compare and navigate to.
  const targetUrl = new URL(rawLink, self.location.origin).href

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })

      // Prefer focusing an app window we already control, so clicking a push never
      // spawns a second copy of the dashboard. Navigate the focused tab to the
      // record the notification points at.
      for (const client of clientList) {
        if ('focus' in client) {
          await client.focus()
          if ('navigate' in client && client.url !== targetUrl) {
            await client.navigate(targetUrl).catch(() => undefined)
          }
          return
        }
      }

      // No window open (push arrived to a closed app) — open one at the link.
      await self.clients.openWindow(targetUrl)
    })()
  )
})

// The browser occasionally expires a subscription server-side (keys rotate, the
// endpoint changes). We can't re-subscribe silently inside the SW — subscribing
// with userVisibleOnly and the VAPID key is a page-context concern — so ask the
// open app to re-establish it. `VERSION` is posted so the client can log/track it.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ includeUncontrolled: true })
      for (const client of clientList) {
        client.postMessage({ type: 'PUSH_RESUBSCRIBE', version: VERSION })
      }
    })()
  )
})
