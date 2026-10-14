import { NextRequest } from 'next/server'
import { ObjectId, type Db } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { isFounderRole } from '@/lib/roles'
import { getDatabase } from '@/lib/mongodb'
import { getBusinessSettingsCollection } from '@/lib/models/Ledger'
import { getMessageCollection, messageToJSON, type Message } from '@/lib/models/Chat'
import { messageEditSchema, isObjectId } from '@/lib/schemas/chat'
import { resolveActiveChannel, guardMessage } from '@/lib/chat-service'
import { sanitizeMessageText } from '@/lib/sanitize'
import { resolveCommentEditWindow } from '@/lib/business-policy'
import { recordAuditEntry } from '@/lib/audit'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string; messageId: string }> }

async function loadMessage(
  db: Db,
  channelId: ObjectId,
  messageId: ObjectId
): Promise<(Message & { _id: ObjectId }) | null> {
  const message = await getMessageCollection(db).findOne({ _id: messageId } as never)
  if (!message || !message.channelId?.equals(channelId)) return null
  return message as Message & { _id: ObjectId }
}

/**
 * PATCH /api/chat/channels/[id]/messages/[messageId]
 *
 * Edit own message within the Founder-configured window, or (Founder) moderate
 * any message. A soft-deleted message is immutable (410). Restoring a deleted
 * message is Founder-only. `createdAt` is preserved so edits never extend the
 * author's own deadline. Both edit and delete are audit-logged.
 */
async function __PATCH(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('chat', 'edit')
    const { id, messageId } = await context.params
    if (!isObjectId(id) || !isObjectId(messageId)) {
      return validationError('Invalid id', [
        { path: 'id', message: 'Malformed' },
        { path: 'messageId', message: 'Malformed' },
      ])
    }

    const parsed = messageEditSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }

    const db = await getDatabase()
    const channel = await resolveActiveChannel(db, new ObjectId(id))
    if (!channel) return notFoundError('Channel not found')

    const message = await loadMessage(db, channel._id, new ObjectId(messageId))
    if (!message) return notFoundError('Message not found')

    const settings = await getBusinessSettingsCollection(db).findOne({ key: 'business' })
    const window = resolveCommentEditWindow(settings)
    const isModerator = isFounderRole(auth.user.role)

    const gate = guardMessage(message, auth.user._id as ObjectId, isModerator, window)
    if (!gate.ok) return errorResponse(gate.message, gate.status, gate.code)

    if (parsed.data.isDeleted === false && !isModerator) {
      return errorResponse('Only a Founder can restore a deleted message', 403, 'FORBIDDEN')
    }

    const now = new Date()
    const set: Record<string, unknown> = { updatedAt: now }
    if (parsed.data.content !== undefined) {
      const clean = sanitizeMessageText(parsed.data.content)
      if (clean.length === 0) {
        return validationError('Validation failed', [
          { path: 'content', message: 'Message cannot be empty' },
        ])
      }
      set.content = clean
      set.editedAt = now
    }
    if (parsed.data.isDeleted === true) {
      set.isDeleted = true
      set.deletedAt = now
      set.deletedBy = auth.user._id as ObjectId
    } else if (parsed.data.isDeleted === false) {
      set.isDeleted = false
      set.deletedAt = null
      set.deletedBy = null
    }

    const col = getMessageCollection(db)
    await col.updateOne({ _id: message._id } as never, { $set: set } as never)
    const updated = (await col.findOne({ _id: message._id } as never))!

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: parsed.data.isDeleted === true ? 'chat_message_deleted' : 'chat_message_updated',
      entityType: 'chat_message',
      entityId: message._id,
      oldValue: { content: message.content, isDeleted: message.isDeleted },
      newValue: { content: updated.content, isDeleted: updated.isDeleted },
      details:
        isModerator && !message.senderId.equals(auth.user._id as ObjectId)
          ? 'moderator action'
          : undefined,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(messageToJSON(updated))
  } catch (error) {
    console.error('PATCH /api/chat/channels/[id]/messages/[messageId] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * DELETE — soft delete. Sets `isDeleted` and redacts the body on serialisation;
 * the physical string stays so the audit story can be reconstructed, but no
 * read path returns it. Same author/window/moderator rules as PATCH.
 */
async function __DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('chat', 'delete')
    const { id, messageId } = await context.params
    if (!isObjectId(id) || !isObjectId(messageId)) {
      return validationError('Invalid id', [
        { path: 'id', message: 'Malformed' },
        { path: 'messageId', message: 'Malformed' },
      ])
    }

    const db = await getDatabase()
    const channel = await resolveActiveChannel(db, new ObjectId(id))
    if (!channel) return notFoundError('Channel not found')

    const message = await loadMessage(db, channel._id, new ObjectId(messageId))
    if (!message) return notFoundError('Message not found')

    const settings = await getBusinessSettingsCollection(db).findOne({ key: 'business' })
    const window = resolveCommentEditWindow(settings)
    const isModerator = isFounderRole(auth.user.role)

    const gate = guardMessage(message, auth.user._id as ObjectId, isModerator, window)
    if (!gate.ok) return errorResponse(gate.message, gate.status, gate.code)

    const now = new Date()
    const col = getMessageCollection(db)
    await col.updateOne(
      { _id: message._id } as never,
      {
        $set: {
          isDeleted: true,
          deletedAt: now,
          deletedBy: auth.user._id as ObjectId,
          updatedAt: now,
        },
      } as never
    )
    const updated = (await col.findOne({ _id: message._id } as never))!

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'chat_message_deleted',
      entityType: 'chat_message',
      entityId: message._id,
      oldValue: { content: message.content },
      newValue: { isDeleted: true },
      details:
        isModerator && !message.senderId.equals(auth.user._id as ObjectId)
          ? 'moderator action'
          : undefined,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(messageToJSON(updated))
  } catch (error) {
    console.error('DELETE /api/chat/channels/[id]/messages/[messageId] failed:', error)
    return handleRouteError(error)
  }
}

export const PATCH = withAuth(__PATCH)
export const DELETE = withAuth(__DELETE)
export const dynamic = 'force-dynamic'
