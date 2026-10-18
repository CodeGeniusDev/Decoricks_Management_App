import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { requireAuth } from '@/lib/authorization'
import { handleRouteError } from '@/lib/http'
import { successResponse } from '@/lib/api-response'
import {
  ensureNotificationIndexes,
  getNotificationCollection,
  notificationToJSON,
} from '@/lib/models/Notifications'
import { maybeRunNotificationSweep } from '@/lib/notifications/sweep'

/**
 * GET /api/notifications — the bell list (design §2.5).
 *
 * Reads ONLY the caller's own documents: the collection is written per-recipient
 * and every query filters `userId` to the authenticated session, so one user can
 * never read another's list even by guessing ids (the brief's IDOR test). No
 * module permission is required to read your OWN notifications — the permission
 * gate already ran at *emit* time, so a row only exists if this user was allowed
 * to see it in the first place.
 *
 * `unread=only|all` narrows the list; the response always carries `unreadCount`
 * so the bell badge and the list never disagree and no second round-trip is
 * needed to keep the count live after a page turn.
 */

export const dynamic = 'force-dynamic'

const PAGE_SIZE_LIMIT = 50

async function __GET(request: NextRequest) {
  const auth = await requireAuth()
  const userId = auth.user._id as ObjectId

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1)
  const rawLimit = Number.parseInt(searchParams.get('limit') ?? '20', 10) || 20
  const limit = Math.min(Math.max(1, rawLimit), PAGE_SIZE_LIMIT)
  const unread = searchParams.get('unread') === 'only'

  const db = await getDatabase()
  await ensureNotificationIndexes(db)

  // Lazy time-sweep (design §2.8): the bell is a natural catch-up point. Awaited
  // (throttled to once per interval, shared across concurrent callers, never
  // rejects) so any overdue / due-soon / low-stock events that crossed while the
  // server slept appear in THIS response rather than arriving as a second paint.
  await maybeRunNotificationSweep(db)

  const col = getNotificationCollection(db)

  const filter: Record<string, unknown> = { userId }
  if (unread) filter.isRead = false

  const [docs, total, unreadCount] = await Promise.all([
    col
      .find(filter as never)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    col.countDocuments(filter as never),
    // The badge count ignores the current filter so it is always the true
    // number of unread items, whether the list is narrowed to unread or not.
    col.countDocuments({ userId, isRead: false } as never),
  ])

  return successResponse({
    notifications: docs.map(notificationToJSON),
    unreadCount,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasMore: page * limit < total,
    },
  })
}

export const GET = async (request: NextRequest): Promise<Response> => {
  try {
    return await __GET(request)
  } catch (error) {
    return handleRouteError(error)
  }
}
