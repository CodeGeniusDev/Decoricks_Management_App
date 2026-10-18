/**
 * Client Web Push helper (design §10 / decision D7).
 *
 * The single channel for OS-level desktop/mobile notifications in Step 2 is Web
 * Push delivered by `/sw.js`. That one choice satisfies the whole of brief §2.2:
 *   - "permission only after a user action" → `Notification.requestPermission()`
 *     is called only from `enablePush()`, which is wired to a button click.
 *   - "handle denied/unsupported gracefully" → every failure returns a typed
 *     reason so the UI can explain it instead of throwing.
 *   - "no duplicates when several tabs are open" → the shared SW shows each
 *     notification once, keyed by `tag: notificationId`.
 *
 * Push is an accelerator layered on `emitNotification`, not a dependency: if any
 * step is unavailable (no SW support, insecure origin, VAPID unconfigured, denied)
 * the in-app bell and the Phase 7 live signal still work. This mirrors the server,
 * where `deliverPush` is a silent no-op when unconfigured.
 *
 * Browser-only; every entry point is safe to import server-side (returns a neutral
 * "unsupported" status) so it cannot drag `window`/`navigator` into a bundle graph.
 */

import { apiFetch, apiJson } from '@/lib/api-client'
import { ensureServiceWorker, getServiceWorker, isServiceWorkerSupported } from './register-service-worker'

export type PushFailure =
  | 'unsupported'
  | 'insecure-context'
  | 'permission-denied'
  | 'permission-dismissed'
  | 'sw-unavailable'
  | 'not-configured'
  | 'subscribe-failed'
  | 'store-failed'

export interface PushStatus {
  /** The browser can do push at all (SW + PushManager + Notification, secure ctx). */
  supported: boolean
  /** The server has VAPID keys configured (probe of /api/push/vapid-public-key). */
  configured: boolean
  permission: NotificationPermission | 'unsupported'
  subscribed: boolean
  /** Fully wired: supported + configured + granted + subscribed. */
  active: boolean
}

export interface EnablePushResult {
  ok: boolean
  reason?: PushFailure
}

const isPushCapable = (): boolean =>
  typeof window !== 'undefined' &&
  isServiceWorkerSupported() &&
  'PushManager' in window &&
  'Notification' in window &&
  window.isSecureContext

/** `Notification.permission` without touching the API on the server. */
export const currentPermission = (): NotificationPermission | 'unsupported' =>
  typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported'

/** VAPID applicationServerKey is base64url; PushManager needs raw bytes. */
const urlBase64ToUint8Array = (base64String: string): Uint8Array<ArrayBuffer> => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const bytes = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i += 1) bytes[i] = rawData.charCodeAt(i)
  return bytes
}

/**
 * Full status for the UI. Non-interactive: reads existing state only, requests no
 * permission and registers no worker (the `configured` probe is the one server call,
 * and it is cheap + auth-scoped). Call this on mount to decide which affordance to
 * show — "Enable", "On", or "unsupported on this device".
 */
export async function getPushStatus(): Promise<PushStatus> {
  const supported = isPushCapable()
  const permission = currentPermission()

  let configured = false
  if (supported) {
    try {
      const vapid = await apiJson<{ enabled: boolean; publicKey: string | null }>(
        '/api/push/vapid-public-key'
      )
      configured = Boolean(vapid?.enabled && vapid.publicKey)
    } catch {
      configured = false
    }
  }

  let subscribed = false
  if (supported) {
    const registration = await getServiceWorker()
    const subscription = await registration?.pushManager.getSubscription().catch(() => null)
    subscribed = Boolean(subscription)
  }

  return {
    supported,
    configured,
    permission,
    subscribed,
    active: supported && configured && permission === 'granted' && subscribed,
  }
}

/**
 * Enable push. MUST be called synchronously from a user gesture (a click) so the
 * permission prompt is legitimate — the brief forbids prompting on page load.
 * Never throws; returns a typed reason on any failure so the UI can explain the
 * exact state (denied vs device-unsupported vs server-not-configured).
 */
export async function enablePush(): Promise<EnablePushResult> {
  if (!isPushCapable()) {
    return { ok: false, reason: typeof window !== 'undefined' && !window.isSecureContext ? 'insecure-context' : 'unsupported' }
  }

  // The only place we ever ask for the Notification permission, and only because
  // the user just clicked. `default` → the user dismissed the browser prompt.
  const permission = await Notification.requestPermission()
  if (permission === 'denied') return { ok: false, reason: 'permission-denied' }
  if (permission !== 'granted') return { ok: false, reason: 'permission-dismissed' }

  const registration = await ensureServiceWorker()
  if (!registration) return { ok: false, reason: 'sw-unavailable' }

  let publicKey: string | null = null
  try {
    const vapid = await apiJson<{ enabled: boolean; publicKey: string | null }>(
      '/api/push/vapid-public-key'
    )
    publicKey = vapid?.enabled ? vapid.publicKey : null
  } catch {
    return { ok: false, reason: 'not-configured' }
  }
  if (!publicKey) return { ok: false, reason: 'not-configured' }

  let subscription: PushSubscription
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
  } catch {
    return { ok: false, reason: 'subscribe-failed' }
  }

  try {
    await apiFetch('/api/push/subscription', {
      method: 'PUT',
      body: JSON.stringify(subscription.toJSON()),
    })
  } catch {
    return { ok: false, reason: 'store-failed' }
  }

  return { ok: true }
}

/**
 * Turn push off for THIS device: unsubscribe the browser endpoint and drop the
 * stored subscription server-side (scoped to the caller, so it can only remove
 * its own device). Best-effort — a partial failure still leaves the user unable to
 * receive push because the local subscription is gone.
 */
export async function disablePush(): Promise<void> {
  if (!isPushCapable()) return
  const registration = await getServiceWorker()
  const subscription = await registration?.pushManager.getSubscription().catch(() => null)
  if (!subscription) return

  const endpoint = subscription.endpoint
  try {
    await subscription.unsubscribe()
  } catch {
    // Even if the browser-side unsubscribe throws, try to purge the server copy.
  }
  try {
    await apiFetch('/api/push/subscription', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    })
  } catch {
    // The endpoint is dead locally, so it will simply 410 and self-clean later.
  }
}

/**
 * Silently (re)assert the current subscription to the server on app open, WITHOUT
 * prompting for permission. Needed because a re-deploy or an endpoint rotation can
 * desync the stored subscription, and the `pushsubscriptionchange` event tells the
 * open app to refresh. Never requests permission and never registers a fresh worker
 * — it only PUTs an already-existing subscription, so it is safe to call on mount.
 */
export async function resyncPushSubscription(): Promise<void> {
  if (!isPushCapable()) return
  if (currentPermission() !== 'granted') return

  const registration = await getServiceWorker()
  const subscription = await registration?.pushManager.getSubscription().catch(() => null)
  if (!subscription) return

  await apiFetch('/api/push/subscription', {
    method: 'PUT',
    body: JSON.stringify(subscription.toJSON()),
  }).catch(() => undefined)
}
