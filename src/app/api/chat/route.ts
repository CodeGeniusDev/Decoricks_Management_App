import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { getDatabase } from '@/lib/mongodb'
import { getMessageCollection, type Message } from '@/lib/models/Chat'
import { messageSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { errorResponse, successResponse, validationError } from '@/lib/api-response'
import { ObjectId } from 'mongodb'

const messageToJSON = (m: Message) => ({
  _id: m._id?.toString(),
  senderId: m.senderId.toString(),
  senderName: m.senderName,
  content: m.content,
  isSystem: m.isSystem,
  createdAt: m.createdAt,
})

/**
 * GET /api/chat
 *
 * Reads persisted team messages from MongoDB.
 *
 * Query params:
 *   since  only return messages created after this epoch-ms value (polling)
 *   limit  max messages, 1-200 (default 50)
 *   before paginate backwards: return messages older than this message id
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('chat', 'view')

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

    const db = await getDatabase()
    const col = getMessageCollection(db)

    const filter: Record<string, unknown> = {}
    if (since !== undefined) filter.createdAt = { $gt: new Date(since) }
    if (before && /^[0-9a-fA-F]{24}$/.test(before)) filter._id = { $lt: new ObjectId(before) }

    // Newest-last is what the chat view renders, so query ascending and cap.
    const docs = await col.find(filter).sort({ createdAt: -1 }).limit(limit).toArray()

    return successResponse(docs.reverse().map(messageToJSON))
  } catch (error) {
    console.error('GET /api/chat failed:', error)
    return handleRouteError(error)
  }
}

/**
 * POST /api/chat
 *
 * Persists a message. The sender identity is taken from the authenticated
 * session, never from the request body — otherwise any signed-in user could
 * post as someone else or forge a `isSystem` message. `isSystem` is always
 * false here; system messages are written directly by server-side flows.
 */
async function __POST(request: NextRequest) {
  try {
    const auth = await authorize('chat', 'create')

    const body = await request.json()

    const parsed = messageSchema.safeParse(body)
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }
    const { content } = parsed.data

    if (!auth.user._id) {
      return errorResponse('Your session is no longer valid', 401, 'UNAUTHENTICATED')
    }

    const db = await getDatabase()
    const doc: Message = {
      senderId: auth.user._id,
      senderName: auth.user.name,
      content,
      isSystem: false,
      createdAt: getKarachiDate(),
    }

    const result = await getMessageCollection(db).insertOne(doc)
    const saved: Message = { ...doc, _id: result.insertedId }

    return successResponse(messageToJSON(saved), 201)
  } catch (error) {
    console.error('POST /api/chat failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
