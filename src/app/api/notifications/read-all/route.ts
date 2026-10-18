import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { requireAuth } from '@/lib/authorization'
import { handleRouteError } from '@/lib/http'
import { successResponse } from '@/lib/api-response'
import { getNotificationCollection } from '@/lib/models/Notifications'
import { realtimeBus } from '@/lib/realtime/bus'

/**
 * POST /api/notifications/read-all — clear the bell in one action.
 *
 * Scoped to `{ userId, isRead: false }` so it only ever touches the caller's own
 * unread rows (a bulk `$set` across someone else's documents is impossible).
 * After it lands we publish the user-scoped `notifications` signal: every open
 * tab of THIS user then refetches its unread count through the Phase 7 live layer
 * (or its polling fallback), which is what stops a second tab from showing a
 * stale badge after the first one cleared it.
 */

export const dynamic = 'force-dynamic'

async function __POST() {
  const auth = await requireAuth()
  const userId = auth.user._id as ObjectId

  const db = await getDatabase()
  const result = await getNotificationCollection(db).updateMany(
    { userId, isRead: false } as never,
    { $set: { isRead: true, readAt: new Date() } } as never
  )

  realtimeBus.publish('notifications', Date.now(), userId.toString())

  return successResponse({ marked: result.modifiedCount ?? 0 })
}

export const POST = async (): Promise<Response> => {
  try {
    return await __POST()
  } catch (error) {
    return handleRouteError(error)
  }
}
