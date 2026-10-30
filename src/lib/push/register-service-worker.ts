/**
 * Service-worker registration for Phase 9 Web Push (design §5, §10 / D7).
 *
 * Registration has two entry points, deliberately. Step 3's offline shell needs a
 * worker controlling the app before any prompt, so `OfflineProvider` registers it
 * eagerly in production builds (and unregisters it in development, where a
 * cache-first worker breaks Fast Refresh). "Enable notifications" uses the same
 * idempotent `ensureServiceWorker`, which is what makes push work on a browser
 * that never visited the offline path. Registering a SW is not itself a
 * permission prompt — the prompt only comes from `showNotification`/`subscribe`,
 * both behind a gesture.
 *
 * The Step 2 worker only received push events. Step 3 layered versioned offline
 * caching onto this same registration, which is why every cache decision lives in
 * `public/sw.js` and nothing in page code touches the Cache API directly.
 *
 * Browser-only: every export no-ops on the server so it can never leak into a
 * server bundle graph and reference `navigator`.
 */

const SW_URL = '/sw.js'

export const isServiceWorkerSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator

/**
 * Register (or reuse) the worker and resolve once it is active. `register` is
 * idempotent — calling it again returns the existing registration — so repeated
 * enable attempts are harmless. Resolves `null` (never throws) when unsupported or
 * when registration fails (e.g. a non-secure origin), letting the caller fall back
 * to in-app-only notifications instead of showing a broken prompt.
 */
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isServiceWorkerSupported()) return null
  try {
    const registration = await navigator.serviceWorker.register(SW_URL, { scope: '/' })
    // `register` resolves before the worker is necessarily activated; wait for an
    // active SW so an immediately-following `pushManager.subscribe` succeeds.
    if (!navigator.serviceWorker.controller) {
      await navigator.serviceWorker.ready
    }
    return registration
  } catch {
    return null
  }
}

/** Existing registration, if any, without forcing one into existence. */
export async function getServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isServiceWorkerSupported()) return null
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null
  } catch {
    return null
  }
}

/**
 * Tear the worker down and unregister it. Used by Step 3's wipe-on-logout and by
 * `disablePush` after the subscription has been removed server-side, so no orphan
 * worker lingers to receive push for a signed-out device.
 */
export async function unregisterServiceWorker(): Promise<void> {
  const registration = await getServiceWorker()
  if (!registration) return
  try {
    await registration.unregister()
  } catch {
    // Best-effort; a failed unregister is not worth surfacing to the user.
  }
}

/**
 * Ask the active worker to drop the cached DOCUMENTS only — the shell, the icons
 * and the hashed build assets stay, so the next sign-in is not a cold download.
 *
 * Unregistering instead would also kill push delivery for a device that merely
 * signed out of one account, and keeping a signed-out account's page snapshots
 * on a shared machine is not what "wipe on logout" means. The worker owns the
 * cache names, so this posts a message rather than reaching into the Cache API
 * from page code.
 */
export async function purgePageCaches(): Promise<void> {
  const registration = await getServiceWorker()
  try {
    registration?.active?.postMessage({ type: 'PURGE_PAGE_CACHES' })
  } catch {
    // Best-effort: the document hand-off below already leaves a fresh app.
  }
}
