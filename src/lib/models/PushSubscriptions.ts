import type { Collection, Db } from 'mongodb'
import { ObjectId } from 'mongodb'

/**
 * Phase 9 Web Push subscriptions (design §10 Option B, decision D7).
 *
 * One row per browser subscription. A user can have many (phone + laptop + a
 * second browser); `endpoint` is the browser-supplied unique URL, so it is the
 * natural unique key. We store only what `web-push` needs to send: the endpoint
 * and the two client public keys. No token, no password, no record data — the
 * push payload itself is the dataless notification title/body built at emit time.
 *
 * Free-tier reality: subscriptions die. A `410 Gone` (or `404`) response from the
 * browser push service means the subscription is expired and MUST be deleted,
 * otherwise every future emit wastes a request on it. `deliverPush` does that
 * cleanup inline (design §10 risk note).
 */
export interface PushSubscriptionDoc {
  _id?: ObjectId
  userId: ObjectId
  /** Browser push endpoint; unique — a re-subscribe upserts the same row. */
  endpoint: string
  keys: {
    p256dh: string
    auth: string
  }
  createdAt: Date
  updatedAt: Date
}

export const getPushSubscriptionCollection = (db: Db): Collection<PushSubscriptionDoc> =>
  db.collection<PushSubscriptionDoc>('pushSubscriptions')

let pushIndexesPromise: Promise<void> | null = null

export function ensurePushIndexes(db: Db): Promise<void> {
  if (!pushIndexesPromise) {
    pushIndexesPromise = (async () => {
      try {
        await Promise.all([
          getPushSubscriptionCollection(db).createIndex(
            { endpoint: 1 },
            { unique: true, name: 'pushSubscriptions_endpoint_unique' }
          ),
          getPushSubscriptionCollection(db).createIndex(
            { userId: 1 },
            { name: 'pushSubscriptions_user' }
          ),
        ])
      } catch (error) {
        pushIndexesPromise = null
        console.error('ensurePushIndexes failed:', error)
      }
    })()
  }
  return pushIndexesPromise
}
