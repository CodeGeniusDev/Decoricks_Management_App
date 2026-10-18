import type { Db } from 'mongodb'
import { ObjectId } from 'mongodb'
import { getEnv } from '@/lib/env'
import {
  ensurePushIndexes,
  getPushSubscriptionCollection,
} from '@/lib/models/PushSubscriptions'

/**
 * Phase 9 Web Push fan-out (design §10 Option B, decision D7).
 *
 * BEST-EFFORT and NEVER THROWS: push is an accelerator on top of the in-app
 * centre, not a guarantee. If VAPID keys are unconfigured the whole module is a
 * silent no-op — the app still works via the notification list, the Phase 7
 * live signal and the browser Notification API while a tab is open. A push
 * transport error, an expired subscription or a missing key must never break the
 * `emitNotification` insert that already succeeded.
 *
 * Honest limit (documented in the design doc): on a *sleeping* free host nothing
 * fans out while the process is down, so push for the lazy time-based sweep is
 * late until the next request wakes the server. This is inherent to free-tier
 * infra, not a bug to hide.
 */

export interface PushPayload {
  title: string
  body: string
  /** In-app route the notification click opens. */
  link?: string
  /** Notification `_id`, so the SW can dedupe across tabs and deep-link. */
  notificationId?: string
  type?: string
}

let configured = false
let configUnavailable = false

/** Lazily configure `web-push` with VAPID; returns false when unconfigured. */
async function ensureConfigured(): Promise<boolean> {
  if (configured) return true
  if (configUnavailable) return false

  const { VAPID_PRIVATE_KEY, VAPID_SUBJECT } = getEnv()
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  if (!VAPID_PRIVATE_KEY || !VAPID_SUBJECT || !publicKey) {
    configUnavailable = true
    return false
  }

  try {
    // Dynamic import keeps the Node-only `web-push` (and its `http`/`https` use)
    // out of any client/edge bundle graph.
    const webpush = (await import('web-push')).default
    webpush.setVapidDetails(VAPID_SUBJECT, publicKey, VAPID_PRIVATE_KEY)
    configured = true
    return true
  } catch (error) {
    configUnavailable = true
    console.error('[push] VAPID configuration failed:', error)
    return false
  }
}

/**
 * Send `payload` to every stored subscription for `userId`. Expired endpoints
 * (410 Gone / 404) are deleted inline so the collection does not accumulate dead
 * subscriptions that every future emit would waste a request on.
 */
export async function deliverPush(db: Db, userId: string, payload: PushPayload): Promise<void> {
  if (!(await ensureConfigured())) return

  try {
    await ensurePushIndexes(db)
    const collection = getPushSubscriptionCollection(db)
    const subs = await collection.find({ userId: new ObjectId(userId) }).toArray()
    if (subs.length === 0) return

    const webpush = (await import('web-push')).default
    const data = JSON.stringify(payload)

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            data
          )
        } catch (error) {
          const statusCode = (error as { statusCode?: number }).statusCode
          // 410 Gone / 404: the subscription is dead — drop it. Any other error
          // (rate limit, transient 5xx) is left in place to retry next emit.
          if (statusCode === 410 || statusCode === 404) {
            await collection.deleteOne({ _id: sub._id }).catch(() => undefined)
          }
        }
      })
    )
  } catch (error) {
    // Push is best-effort; the notification row and live signal already landed.
    console.error('[push] deliverPush failed:', error)
  }
}
