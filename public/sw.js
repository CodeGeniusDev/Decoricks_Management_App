/*
 * Decoricks service worker — Phase 9, Step 2: Web Push ONLY.
 *
 * There is deliberately NO `fetch` handler in this file yet. That is not an
 * oversight: without one the SW cannot intercept or cache ANY request, so it is
 * impossible for it to serve a stale app shell or cache a financial `/api/*`
 * response — the two failure modes the brief calls out. Versioned offline
 * caching of the app shell is introduced in Step 3 under its own review, with a
 * `decoricks-shell-v{n}` cache that never touches `/api/`.
 *
 * Everything here is about push delivery and notification clicks. The SW is a
 * single instance per origin shared by every tab, and each notification is shown
 * with `tag: notificationId`, so:
 *   - several open tabs can never stack duplicate OS notifications, and
 *   - a push redelivered by the browser (same id) replaces rather than repeats.
 *
 * This file is plain JS (served verbatim from /public), so it uses no imports.
 */

// Bumping this is how Step 3 will force a controlled cache refresh. For Step 2 it
// only documents intent; there is no cache to version yet.
const VERSION = 'phase9-push-v1'

self.addEventListener('install', () => {
  // A push-only SW has nothing to displace, so activating immediately is safe and
  // lets a just-enabled subscription work without waiting for the next navigation.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
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
