import type { Db } from 'mongodb'
import { ObjectId } from 'mongodb'
import { getEnv } from '@/lib/env'
import { ensurePushIndexes, getPushSubscriptionCollection } from '@/lib/models/PushSubscriptions'

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
/** The public key in use, resolved once from the runtime private key. */
let effectivePublicKey: string | null = null

/**
 * The public point of a P-256 key, given its private scalar (both base64url).
 * `web-push` generates and stores the pair as raw scalars, so an ECDH round trip
 * recovers the public key byte for byte. Returns null for anything that is not a
 * 32-byte scalar (a pasted PEM, a typo, a truncated value).
 */
const deriveVapidPublicKey = async (privateKey: string): Promise<string | null> => {
  try {
    // Dynamic import keeps Node-only crypto out of any bundle graph that might
    // pull this module toward the client, exactly like the `web-push` import below.
    const { createECDH } = await import('node:crypto')
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'))
    const raw = ecdh.getPublicKey()
    // Same left-padding `web-push` applies when OpenSSL shortens the point: the
    // browser's `applicationServerKey` must be exactly the 65 bytes it is.
    const point = raw.length < 65 ? Buffer.concat([Buffer.alloc(65 - raw.length), raw]) : raw
    return point.toString('base64url')
  } catch {
    return null
  }
}

/**
 * The public VAPID key the client needs to subscribe, or null when push is not
 * configured. Read in ONE place so the `/api/push/vapid-public-key` route and the
 * server-side `ensureConfigured` never disagree about whether push is enabled or
 * about WHICH key is authoritative. This is the only VAPID value ever exposed to
 * the browser — the private key and subject stay server-side.
 *
 * It is async and DERIVED FROM THE PRIVATE KEY on purpose. `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
 * is inlined into the server bundle at BUILD time, so rotating the VAPID pair and
 * only restarting leaves the old public key baked in while the new private key is
 * read at runtime. The browser then subscribes with a key that does not belong to
 * the signer, the push service rejects every send with a VAPID 401, and the owner
 * sees nothing at all. The private key is the only value that can be trusted at
 * runtime, so the browser is handed the public key that matches it.
 */
export const getVapidPublicKey = async (): Promise<string | null> =>
  (await ensureConfigured()) ? effectivePublicKey : null

/** Lazily configure `web-push` with VAPID; returns false when unconfigured. */
async function ensureConfigured(): Promise<boolean> {
  if (configured) return true
  if (configUnavailable) return false

  const { VAPID_PRIVATE_KEY, VAPID_SUBJECT } = getEnv()
  if (!VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    configUnavailable = true
    return false
  }

  // The build-time value is only a fallback for a private key we cannot expand;
  // when it disagrees with the private key, the derived one wins and the drift is
  // logged instead of silently breaking every notification.
  const buildTimeKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || null
  const derivedKey = await deriveVapidPublicKey(VAPID_PRIVATE_KEY)
  effectivePublicKey = derivedKey ?? buildTimeKey

  if (!effectivePublicKey) {
    configUnavailable = true
    return false
  }

  if (derivedKey && buildTimeKey && derivedKey !== buildTimeKey) {
    // Both values are public keys the browser can already read; no secret is
    // printed. The action needed is in the message, not in the crypto.
    console.error(
      '[push] VAPID drift: NEXT_PUBLIC_VAPID_PUBLIC_KEY was baked into this build ' +
        'and does not match the runtime VAPID_PRIVATE_KEY. Push uses the derived key, ' +
        'so sends stay signed by the pair the browser is told about and delivery ' +
        'keeps working — but set the new public key before the next build so the two ' +
        'agree and this message goes away.'
    )
  }

  try {
    // Dynamic import keeps the Node-only `web-push` (and its `http`/`https` use)
    // out of any client/edge bundle graph.
    const webpush = (await import('web-push')).default
    webpush.setVapidDetails(VAPID_SUBJECT, effectivePublicKey, VAPID_PRIVATE_KEY)
    configured = true
    return true
  } catch (error) {
    configUnavailable = true
    effectivePublicKey = null
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
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, data)
        } catch (error) {
          const statusCode = (error as { statusCode?: number }).statusCode
          // 410 Gone / 404: the subscription is dead — drop it. Any other error
          // (rate limit, transient 5xx) is left in place to retry next emit.
          if (statusCode === 410 || statusCode === 404) {
            await collection.deleteOne({ _id: sub._id }).catch(() => undefined)
            console.warn(`[push] expired subscription removed (HTTP ${statusCode})`)
          } else {
            // Everything else used to vanish. A VAPID mismatch, a bad subject
            // (`mailto:` rules are strict) or a transport failure all looked
            // identical to "push works, the phone is just quiet" — which is
            // exactly how a deployment-wide misconfiguration survives for weeks.
            // The endpoint is a bearer token, so it is never printed.
            console.error(
              `[push] send failed for one subscription (HTTP ${
                statusCode ?? 'no response'
              }): ${(error as Error)?.message ?? error}`
            )
          }
        }
      })
    )
  } catch (error) {
    // Push is best-effort; the notification row and live signal already landed.
    console.error('[push] deliverPush failed:', error)
  }
}
