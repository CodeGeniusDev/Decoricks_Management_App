import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { requireAuth } from '@/lib/authorization'
import { HttpError, handleRouteError } from '@/lib/http'
import { successResponse } from '@/lib/api-response'
import {
  getNotificationCollection,
  notificationToJSON,
  type NotificationDoc,
} from '@/lib/models/Notifications'

/**
 * PATCH /api/notifications/[id] — mark one notification read or unread.
 *
 * The update filter is `{ _id, userId }`, NOT `_id` alone: a caller who guesses
 * another user's notification id matches zero documents and gets a 404, so the
 * route cannot be used to mutate (or even probe) someone else's list. Reading
 * your own notification state needs no module permission — the same reasoning as
 * the list endpoint (the permission gate ran at emit time).
 *
 * Body: `{ isRead?: boolean }`. Toggling read also stamps/clears `readAt` so the
 * client can sort or display "read on" without a second field.
 */

export const dynamic = 'force-dynamic'

async function __PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth()
  const userId = auth.user._id as ObjectId
  const { id } = await context.params

  if (!ObjectId.isValid(id)) throw new HttpError('Invalid notification id', 400, 'BAD_REQUEST')

  const body = (await request.json().catch(() => ({}))) as { isRead?: unknown }
  if (typeof body.isRead !== 'boolean') {
    throw new HttpError('`isRead` must be a boolean', 400, 'VALIDATION_ERROR')
  }

  const db = await getDatabase()
  const col = getNotificationCollection(db)

  const updated = await col.findOneAndUpdate(
    { _id: new ObjectId(id), userId } as never,
    { $set: { isRead: body.isRead, readAt: body.isRead ? new Date() : null } } as never,
    { returnDocument: 'after' }
  )

  if (!updated) throw new HttpError('Notification not found', 404, 'NOT_FOUND')

  return successResponse(notificationToJSON(updated as unknown as NotificationDoc))
}

export const PATCH = async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> => {
  try {
    return await __PATCH(request, context)
  } catch (error) {
    return handleRouteError(error)
  }
}
