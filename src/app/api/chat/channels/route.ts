import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta, logRouteFailure } from '@/lib/http'
import { authorize, requireFounder } from '@/lib/authorization'
import { isFounderRole } from '@/lib/roles'
import { getDatabase } from '@/lib/mongodb'
import {
  channelToJSON,
  ensureChatCollections,
  getChannelCollection,
  getMessageCollection,
} from '@/lib/models/Chat'
import { channelCreateSchema } from '@/lib/schemas/chat'
import { computeUnreadCounts } from '@/lib/chat-service'
import { recordAuditEntry } from '@/lib/audit'
import { conflictError, successResponse, validationError } from '@/lib/api-response'

/**
 * /api/chat/channels
 *
 * GET  — the channels this member can see. Chat is open to all four members, so
 *        every active channel is returned; the payload additionally carries the
 *        caller's per-channel unread count and a `canManage` flag that drives
 *        the Founder-only controls in the UI. (`canManage` is presentational —
 *        the mutating routes enforce Founder-ness independently.)
 *
 *        `?archived=true` is the Archived Chats list: Founder-only, because
 *        archiving is a Founder act and an archived room is one the team closed
 *        — a Partner who could not archive it should not be able to browse what
 *        was hidden. Sorted most-recently-touched first and reporting each
 *        room's message count, so "the history is still there" is visible rather
 *        than assumed. Unread counts are not computed here: a closed room is not
 *        something the team is expected to be catching up on.
 *
 * POST — create a channel. Founder-only via `requireFounder`, which no
 *        permission grant can open.
 */

/** `?archived=true|1` — the only query this route understands. */
const wantsArchived = (raw: string | null): boolean => raw === 'true' || raw === '1'

async function __GET(request: NextRequest) {
  try {
    const archived = wantsArchived(new URL(request.url).searchParams.get('archived'))
    // Founder-only for the archive, permission-gated for the live list. Both
    // paths still 401 with no session; `requireFounder` additionally records a
    // denied attempt when a Partner asks for what only a Founder may see.
    const auth = archived ? await requireFounder() : await authorize('chat', 'view')
    const db = await getDatabase()
    await ensureChatCollections(db)

    const channels = await getChannelCollection(db)
      .find({ isArchived: archived } as never)
      .sort(archived ? { updatedAt: -1 } : ({ createdAt: 1 } as never))
      .toArray()

    const userId = auth.user._id as ObjectId
    if (archived) {
      const messages = getMessageCollection(db)
      const data = await Promise.all(
        channels.map(async (c) => ({
          ...channelToJSON(c),
          unreadCount: 0,
          canManage: true,
          // Proof of preservation, cheap and indexed by `{ channelId, createdAt }`.
          messageCount: await messages.countDocuments({ channelId: c._id } as never),
        }))
      )
      return successResponse(data)
    }

    const unread = await computeUnreadCounts(
      db,
      userId,
      channels.map((c) => c._id as ObjectId)
    )

    const canManage = isFounderRole(auth.user.role)
    const data = channels.map((c) => ({
      ...channelToJSON(c),
      unreadCount: unread[c._id?.toString() ?? ''] ?? 0,
      canManage,
    }))

    return successResponse(data)
  } catch (error) {
    logRouteFailure('GET /api/chat/channels', error)
    return handleRouteError(error)
  }
}

/** Lowercase, hyphen-joined slug; falls back to `channel` when the name is all symbols. */
const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41) || 'channel'

async function __POST(request: NextRequest) {
  try {
    const auth = await requireFounder()

    const parsed = channelCreateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }

    const db = await getDatabase()
    await ensureChatCollections(db)

    const key = parsed.data.key ?? slugify(parsed.data.name)
    const existing = await getChannelCollection(db).findOne({ key } as never)
    if (existing) {
      return conflictError(`A channel with handle "${key}" already exists`)
    }

    const now = new Date()
    const doc = {
      key,
      name: parsed.data.name,
      description: parsed.data.description,
      isArchived: false,
      createdBy: auth.user._id as ObjectId,
      createdAt: now,
      updatedAt: now,
    }
    const result = await getChannelCollection(db).insertOne(doc as never)

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'chat_channel_created',
      entityType: 'chat_channel',
      entityId: result.insertedId,
      newValue: { key, name: doc.name },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(
      { ...channelToJSON({ ...doc, _id: result.insertedId }), unreadCount: 0, canManage: true },
      201
    )
  } catch (error) {
    logRouteFailure('POST /api/chat/channels', error)
    // requireFounder throws AuthorizationError → 403 via handleRouteError.
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
export const dynamic = 'force-dynamic'
