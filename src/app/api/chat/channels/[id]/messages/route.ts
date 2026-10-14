import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { isFounderRole } from '@/lib/roles'
import { getDatabase } from '@/lib/mongodb'
import { getBusinessSettingsCollection } from '@/lib/models/Ledger'
import { resolveCommentEditWindow, commentWithinEditWindow } from '@/lib/business-policy'
import { ensureChatCollections, getMessageCollection, messageToJSON } from '@/lib/models/Chat'
import { messageSendSchema, isObjectId } from '@/lib/schemas/chat'
import { resolveActiveChannel, sendIdempotent } from '@/lib/chat-service'
import { messageSendLimiter } from '@/lib/rate-limit'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * /api/chat/channels/[id]/messages
 *
 * GET  — channel history with cursor pagination. The client loads the newest
 *        `limit` on open and fetches older pages with `before=<oldest id>` on
 *        scroll-up; `since=<epoch-ms>` is the incremental tail used by the
 *        polling fallback. Always newest-last so the view renders directly.
 * POST — send a message. Sender identity comes from the session, content is
 *        sanitised to plain text, and a client-generated `clientId` makes the
 *        insert idempotent so a retry after a dropped response can never
 *        duplicate. Sending is rate-limited per (user, channel).
 *
 * Chat is open to every member, so both verbs gate on `chat.view` /
 * `chat.create` (all four roles hold these); channel existence is checked for a
 * non-archived room.
 */

async function __GET(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('chat', 'view')
    const { id } = await context.params
    if (!isObjectId(id)) {
      return validationError('Invalid channel id', [{ path: 'id', message: 'Malformed' }])
    }

    const db = await getDatabase()
    await ensureChatCollections(db)
    const channel = await resolveActiveChannel(db, new ObjectId(id))
    if (!channel) return notFoundError('Channel not found')

    const { searchParams } = new URL(request.url)
    const sinceRaw = searchParams.get('since')
    const before = searchParams.get('before')
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '50', 10) || 50))

    const since = sinceRaw ? Number(sinceRaw) : undefined
    if (sinceRaw && (!Number.isFinite(since) || since! < 0)) {
      return validationError('Invalid since value', [
        { path: 'since', message: 'Must be an epoch millisecond value' },
      ])
    }

    const filter: Record<string, unknown> = { channelId: channel._id, isDeleted: { $ne: true } }
    if (since !== undefined) filter.createdAt = { $gt: new Date(since) }
    if (before && isObjectId(before)) filter._id = { $lt: new ObjectId(before) }

    const docs = await getMessageCollection(db)
      .find(filter as never)
      .sort({ _id: -1 })
      .limit(limit)
      .toArray()

    // Stamp an authoritative `editable` flag per message for the caller. This
    // uses the *real* configured window and the *real* viewer identity, so the
    // client never shows an edit/delete affordance the server would reject — the
    // server remains the enforcement point; this only drives the UI.
    const settings = await getBusinessSettingsCollection(db).findOne({ key: 'business' })
    const windowMinutes = resolveCommentEditWindow(settings)
    const isModerator = isFounderRole(auth.user.role)
    const viewerId = auth.user._id?.toString()
    const now = new Date()

    const data = docs
      .reverse()
      .map((m) => messageToJSON(m))
      .map((m) => ({
        ...m,
        editable:
          !m.isDeleted &&
          (isModerator ||
            (m.senderId === viewerId && commentWithinEditWindow(m.createdAt, now, windowMinutes))),
      }))

    return successResponse(data)
  } catch (error) {
    console.error('GET /api/chat/channels/[id]/messages failed:', error)
    return handleRouteError(error)
  }
}

async function __POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('chat', 'create')
    const { id } = await context.params
    if (!isObjectId(id)) {
      return validationError('Invalid channel id', [{ path: 'id', message: 'Malformed' }])
    }
    if (!auth.user._id) {
      return errorResponse('Your session is no longer valid', 401, 'UNAUTHENTICATED')
    }

    const parsed = messageSendSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }
    const { content, clientId } = parsed.data

    const db = await getDatabase()
    await ensureChatCollections(db)
    const channel = await resolveActiveChannel(db, new ObjectId(id))
    if (!channel) return notFoundError('Channel not found')

    // Rate-limit before touching the database.
    const rateKey = `${auth.user._id.toString()}:${channel._id.toString()}`
    const rate = messageSendLimiter.consume(rateKey)
    if (!rate.allowed) {
      const res = errorResponse(
        'You are sending messages too quickly. Please slow down.',
        429,
        'RATE_LIMITED',
        { retryAfterMs: rate.retryAfterMs }
      )
      res.headers.set('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)))
      return res
    }

    const { message, created } = await sendIdempotent(db, {
      channelId: channel._id,
      senderId: auth.user._id,
      senderName: auth.user.name,
      content,
      clientId,
    })

    return successResponse({ ...messageToJSON(message), editable: true }, created ? 201 : 200)
  } catch (error) {
    console.error('POST /api/chat/channels/[id]/messages failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
export const dynamic = 'force-dynamic'
