/*
 * Decoricks service worker — Phase 9, Step 3: push + versioned offline shell.
 *
 * Caching model (design doc §5, three zones):
 *   1. PRECACHED SHELL  — `decoricks-shell-v{n}`: offline fallback page, login
 *      HTML, manifest and brand assets, written on `install`.
 *   2. RUNTIME — navigational HTML of visited screens (`decoricks-pages-v{n}`),
 *      kept as an OFFLINE fallback and served network-first (a cached document
 *      belongs to the build that wrote it), and content-hashed
 *      `/_next/static/*` (immutable by construction, safe to keep forever).
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

// Bump the trailing number on every deploy that changes the shell set, and
// whenever the *caching policy* changes — `activate` treats any cache name not
// in the current family as stale, so moving v3 → v4 is what actually discards
// documents the old policy wrote.
const VERSION = 'phase10-offline-v4'
const SHELL_CACHE = 'decoricks-shell-v4'
const PAGES_CACHE = 'decoricks-pages-v4'
const STATIC_CACHE = 'decoricks-static-v4'
const CURRENT_CACHES = [SHELL_CACHE, PAGES_CACHE, STATIC_CACHE]

// Shell precache: static assets batch in; the dynamic login HTML is fetched
// separately so a failure there cannot abort the whole install.
const SHELL_ASSETS = [
  '/offline.html',
  '/manifest.webmanifest',
  // Raster icons: the manifest needs them for Android/iOS install, and
  // notification `icon`/`badge` only accept raster images reliably. The set is
  // PNG/ICO only — the brand mark is raster artwork, so there is no vector
  // variant to precache, and an .svg name holding PNG bytes is a bug.
  '/favicon.ico',
  '/brand-mark.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
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

  // NETWORK FIRST. A cached document is a snapshot of one build: it points at
  // the `/_next/static/*` filenames of THAT build, so serving it first after a
  // deploy renders the old app and can ask for chunks the new build no longer
  // publishes. Documents are only fetched on a real page load (client-side
  // route changes go through RSC requests, which this worker never caches), so
  // waiting for the network costs nothing on navigation count — it just keeps
  // the first paint of a new deploy honest. The cache is the fallback, and the
  // offline page is the fallback for the fallback.
  const network = await fetch(request).catch(() => undefined)
  if (network) {
    if (network.ok) cache.put(request, network.clone())
    return network
  }

  // Offline: the last good copy of this screen, then the shell's login page,
  // then a controlled message — never a browser error page.
  const hit = await cache.match(request, { ignoreSearch: true })
  if (hit) return hit
  // Offline and never visited: controlled fallback page, never a white screen.
  const fallback = (await caches.match('/offline.html')) ?? (await fetch('/offline.html'))
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
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
    return
  }

  // Sign-out. The runtime page cache holds the HTML of screens this account
  // visited; it is only the shell (the app gates its own body), but on a shared
  // device it is still this user's navigation history, and on a rebuild it is
  // one deploy's chunk filenames. Drop it — and only it — so the next person to
  // open the app starts from the network.
  if (event.data && event.data.type === 'PURGE_PAGE_CACHES') {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys()
        await Promise.all(
          keys.filter((k) => k.startsWith('decoricks-pages-')).map((k) => caches.delete(k))
        )
        if (event.source) event.source.postMessage({ type: 'PAGE_CACHES_PURGED' })
      })()
    )
  }
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
    // Raster PNGs, not SVG: the spec and Chrome/Android/Safari only reliably
    // render raster notification `icon`/`badge` — an SVG here silently shows
    // no picture on Android and iOS home-screen installs.
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-maskable-192.png',
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
  // Resolve against the SW origin, then keep only the path and query: a deep
  // link is built server-side, but a navigation must never leave the app no
  // matter what a payload says.
  const resolved = new URL(rawLink, self.location.origin)
  const targetUrl = `${self.location.origin}${resolved.pathname}${resolved.search}`

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
