import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta, logRouteFailure } from '@/lib/http'
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
 *
 * Archive is conversation-wide, not per-user — that is what the existing model
 * already meant (`chatChannels.isArchived` is a single flag on a shared channel,
 * and only the Founder can flip it), so Phase 3 keeps that meaning and makes the
 * archived state *findable* instead of terminal. `archivedAt` is written with
 * the flag so the Archived Chats view can show when a room was put away, and it
 * is nulled on restore rather than left standing, because a channel that reads
 * "archived 3 weeks ago" while sitting in the active list is a lie. Archive and
 * restore are audited as distinct actions: the audit log is the recovery path if
 * anyone ever needs to know who closed a room and when.
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
    if (parsed.data.isArchived !== undefined) {
      set.isArchived = parsed.data.isArchived
      // Toggling the flag always re-states `archivedAt` so the two fields cannot
      // disagree, whether this is an archive, a restore, or a redundant repeat
      // of the state the channel is already in.
      set.archivedAt = parsed.data.isArchived ? now : null
    }

    await col.updateOne({ _id: channel._id } as never, { $set: set } as never)
    const updated = (await col.findOne({ _id: channel._id } as never))!

    // The archive action is judged from the stored transition, not from the
    // request body alone: a PATCH that asks to archive an already-archived room
    // is an update, and must not print a second "archived" audit line.
    const wasArchived = channel.isArchived === true
    const isArchived = updated.isArchived === true
    const action =
      isArchived && !wasArchived
        ? 'chat_channel_archived'
        : wasArchived && !isArchived
          ? 'chat_channel_restored'
          : 'chat_channel_updated'

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action,
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
      // `action` is a free-form string in the audit model, so no union needed.
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(channelToJSON(updated))
  } catch (error) {
    logRouteFailure('PATCH /api/chat/channels/[id]', error)
    return handleRouteError(error)
  }
}

export const PATCH = withAuth(__PATCH)
export const dynamic = 'force-dynamic'
