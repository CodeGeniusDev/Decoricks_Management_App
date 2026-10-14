import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { ensureChatCollections } from '@/lib/models/Chat'
import { markReadSchema, isObjectId } from '@/lib/schemas/chat'
import { resolveActiveChannel, markChannelRead, computeUnreadCounts } from '@/lib/chat-service'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * POST /api/chat/channels/[id]/read — advance the caller's last-read watermark.
 *
 * The client calls this when a channel is opened or the viewport is anchored at
 * the newest message. The watermark is clamped to the server clock so a skewed
 * or forged future `lastReadAt` can never mark a not-yet-sent message as read,
 * and the response returns the channel's refreshed unread count so the sidebar
 * badge updates without a second round-trip to /api/chat/channels.
 *
 * Reading is a `chat.view` action (open to all four members); the channel must
 * exist and be active.
 */
async function __POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('chat', 'view')
    const { id } = await context.params
    if (!isObjectId(id)) {
      return validationError('Invalid channel id', [{ path: 'id', message: 'Malformed' }])
    }

    const body = (await request.json().catch(() => ({}))) as unknown
    const parsed = markReadSchema.safeParse(body)
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }

    const db = await getDatabase()
    await ensureChatCollections(db)
    const channel = await resolveActiveChannel(db, new ObjectId(id))
    if (!channel) return notFoundError('Channel not found')

    // Clamp to now: never trust a client-supplied future timestamp.
    const now = new Date()
    const requested = parsed.data.lastReadAt
    const watermark =
      requested === undefined || requested > now.getTime() ? now : new Date(requested)

    const userId = auth.user._id as ObjectId
    await markChannelRead(db, userId, channel._id, watermark)

    const unread = await computeUnreadCounts(db, userId, [channel._id])

    return successResponse({
      channelId: channel._id.toString(),
      lastReadAt: watermark.toISOString(),
      unreadCount: unread[channel._id.toString()] ?? 0,
    })
  } catch (error) {
    console.error('POST /api/chat/channels/[id]/read failed:', error)
    return handleRouteError(error)
  }
}

export const POST = withAuth(__POST)
export const dynamic = 'force-dynamic'
