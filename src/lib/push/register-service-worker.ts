/**
 * Service-worker registration for Phase 9 Web Push (design §5, §10 / D7).
 *
 * Registered LAZILY — only when the user clicks "Enable notifications" — never on
 * page load. Registering a SW is not itself a permission prompt, but keeping it
 * behind a gesture means an unengaging visitor gets no background worker and no
 * surprise, and it matches the brief's "ask only after a user action."
 *
 * The Step 2 worker has no `fetch` handler, so registering it cannot cache or
 * serve anything; it exists purely to receive push events. Step 3 layers versioned
 * offline caching onto this same registration.
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
