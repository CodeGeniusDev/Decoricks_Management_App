import type { Collection, Db } from 'mongodb'
import { ObjectId } from 'mongodb'
import type { NotificationData, NotificationType } from '@/lib/notifications/types'

/**
 * Phase 9 notifications (SPEC §3.1.21, extended per the design doc §2.1).
 *
 * SPEC's shape is kept; two things the brief requires were added because SPEC
 * omitted them: a server-computed `dedupeKey` (THE dedup mechanism) and read /
 * pagination indexing so the bell list and unread count stay O(log n).
 *
 * The unique `{ userId, dedupeKey }` index is what guarantees the same event
 * never notifies twice even if the server wakes twice, double-fires, or a client
 * tick races — MongoDB is the arbiter, so dedupe survives process restarts and
 * concurrent serverless instances. An insert that violates it is not an error,
 * it is "already notified" (see the emit service).
 *
 * `data` carries ONLY ids, labels and an in-app link — never a figure a viewer
 * may not be entitled to see. A notification can therefore never leak restricted
 * numbers; the client opens `link`, which runs its own permission-checked read.
 */
export interface NotificationDoc {
  _id?: ObjectId
  /** Recipient. Every read/write filters on this — no user sees another's list. */
  userId: ObjectId
  type: NotificationType
  /** Server-computed; unique per user. Duplicates are swallowed, never stored. */
  dedupeKey: string
  title: string
  message: string
  data: NotificationData
  isRead: boolean
  readAt?: Date
  createdAt: Date
}

export const getNotificationCollection = (db: Db): Collection<NotificationDoc> =>
  db.collection<NotificationDoc>('notifications')

export const notificationToJSON = (n: NotificationDoc) => ({
  _id: n._id?.toString(),
  type: n.type,
  title: n.title,
  message: n.message,
  data: n.data,
  isRead: n.isRead,
  readAt: n.readAt ?? null,
  createdAt: n.createdAt,
})

/**
 * Indexes for the notifications collection. Memoized per process; failures are
 * logged rather than thrown so a permissions-restricted deployment still serves
 * reads — matches the `ensureXIndexes` convention used across Phases 3–8.
 *
 * `{ userId, dedupeKey }` unique is the dedup contract and MUST exist before any
 * emit; `{ userId, isRead, createdAt }` backs the bell list and unread count.
 */
let notificationIndexesPromise: Promise<void> | null = null

export function ensureNotificationIndexes(db: Db): Promise<void> {
  if (!notificationIndexesPromise) {
    notificationIndexesPromise = (async () => {
      try {
        await Promise.all([
          getNotificationCollection(db).createIndex(
            { userId: 1, dedupeKey: 1 },
            { unique: true, name: 'notifications_dedupe_unique' }
          ),
          getNotificationCollection(db).createIndex(
            { userId: 1, isRead: 1, createdAt: -1 },
            { name: 'notifications_user_read_created' }
          ),
          getNotificationCollection(db).createIndex(
            { userId: 1, createdAt: -1 },
            { name: 'notifications_user_created' }
          ),
        ])
      } catch (error) {
        notificationIndexesPromise = null
        console.error('ensureNotificationIndexes failed:', error)
      }
    })()
  }
  return notificationIndexesPromise
}
