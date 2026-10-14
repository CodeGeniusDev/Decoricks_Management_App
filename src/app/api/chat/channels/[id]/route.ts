import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { requireFounder } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { channelToJSON, getChannelCollection } from '@/lib/models/Chat'
import { channelUpdateSchema, isObjectId } from '@/lib/schemas/chat'
import { recordAuditEntry } from '@/lib/audit'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * PATCH /api/chat/channels/[id] — Founder-only channel management.
 *
 * Renames, re-describes, or archives/un-archives a channel. There is no hard
 * delete: archiving hides a channel from the list and blocks new posts while
 * preserving its history and the audit trail (mirrors the board model).
 */
async function __PATCH(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireFounder()
    const { id } = await context.params
    if (!isObjectId(id)) {
      return validationError('Invalid channel id', [{ path: 'id', message: 'Malformed' }])
    }

    const parsed = channelUpdateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }

    const db = await getDatabase()
    const col = getChannelCollection(db)
    const channel = await col.findOne({ _id: new ObjectId(id) } as never)
    if (!channel) return notFoundError('Channel not found')

    const now = new Date()
    const set: Record<string, unknown> = { updatedAt: now }
    if (parsed.data.name !== undefined) set.name = parsed.data.name
    if (parsed.data.description !== undefined) set.description = parsed.data.description
    if (parsed.data.isArchived !== undefined) set.isArchived = parsed.data.isArchived

    await col.updateOne({ _id: channel._id } as never, { $set: set } as never)
    const updated = (await col.findOne({ _id: channel._id } as never))!

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: parsed.data.isArchived === true ? 'chat_channel_archived' : 'chat_channel_updated',
      entityType: 'chat_channel',
      entityId: channel._id,
      oldValue: {
        name: channel.name,
        description: channel.description,
        isArchived: channel.isArchived,
      },
      newValue: {
        name: updated.name,
        description: updated.description,
        isArchived: updated.isArchived,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(channelToJSON(updated))
  } catch (error) {
    console.error('PATCH /api/chat/channels/[id] failed:', error)
    return handleRouteError(error)
  }
}

export const PATCH = withAuth(__PATCH)
export const dynamic = 'force-dynamic'
