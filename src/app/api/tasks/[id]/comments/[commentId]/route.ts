import { NextRequest } from 'next/server'
import { ObjectId, type Db } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { getBusinessSettingsCollection } from '@/lib/models/Ledger'
import {
  getTaskCommentCollection,
  taskCommentToJSON,
  type TaskComment,
} from '@/lib/models/Tasks'
import { taskCommentUpdateSchema } from '@/lib/schemas/tasks'
import {
  commentWithinEditWindow,
  resolveCommentEditWindow,
} from '@/lib/business-policy'
import { recordAuditEntry } from '@/lib/audit'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string; commentId: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)

/**
 * Loads the comment and confirms it belongs to the given task, so a client
 * cannot edit comment B by hitting `/tasks/A/comments/B`. Returns a 404
 * response when either lookup misses; callers propagate it unchanged.
 */
async function loadComment(
  taskId: ObjectId,
  commentId: ObjectId
): Promise<{ db: Db; comment: (TaskComment & { _id: ObjectId }) | null }> {
  const db = await getDatabase()
  const comments = getTaskCommentCollection(db)
  const comment = await comments.findOne({ _id: commentId } as never)
  if (!comment || !comment.taskId.equals(taskId)) return { db, comment: null }
  return { db, comment: comment as TaskComment & { _id: ObjectId } }
}

/**
 * Shared authorization for PATCH + DELETE.
 *
 * Row-level rules (brief §"comment edit window"):
 *   1. A soft-deleted comment is immutable — return 410 Gone. The audit trail
 *      is what tells the story after that.
 *   2. The Founder (anyone with `tasks.editOthers`) may edit or delete any
 *      comment at any time; this is the "moderation" path.
 *   3. The author may act only within `commentEditWindowMinutes` of posting.
 *      After the window closes, only the Founder can change it.
 *   4. Anyone else gets 403.
 *
 * Returns `{ ok: true, comment, window }` or `{ ok: false, response }`.
 */
async function guardComment(
  canModerateOthers: boolean,
  viewerUserId: ObjectId,
  comment: TaskComment & { _id: ObjectId },
  windowMinutes: number
): Promise<{ ok: true } | { ok: false; response: ReturnType<typeof errorResponse> }> {
  if (comment.isDeleted) {
    return {
      ok: false,
      response: errorResponse('Comment has already been deleted', 410, 'COMMENT_DELETED'),
    }
  }
  if (canModerateOthers) return { ok: true }
  if (!comment.authorId.equals(viewerUserId)) {
    return {
      ok: false,
      response: errorResponse('You can only edit or delete your own comments', 403, 'FORBIDDEN'),
    }
  }
  if (!commentWithinEditWindow(comment.createdAt, new Date(), windowMinutes)) {
    return {
      ok: false,
      response: errorResponse(
        `The edit window (${windowMinutes} min) has closed. Ask the Founder to moderate this comment.`,
        403,
        'COMMENT_WINDOW_CLOSED'
      ),
    }
  }
  return { ok: true }
}

/**
 * PATCH /api/tasks/[id]/comments/[commentId]
 *
 * Body: `{ body?: string, isDeleted?: boolean }`. Both mutations preserve
 * `createdAt` so the edit-window clock never resets — a common bug in
 * "edit then re-edit" flows. `editedAt` is written only on the body change.
 */
async function __PATCH(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('tasks', 'comment')
    const { id, commentId } = await context.params
    if (!isObjectId(id) || !isObjectId(commentId)) {
      return validationError('Invalid id', [
        { path: 'id', message: 'Malformed' },
        { path: 'commentId', message: 'Malformed' },
      ])
    }

    const parsed = taskCommentUpdateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }
    if (parsed.data.body === undefined && parsed.data.isDeleted === undefined) {
      return validationError('No changes', [{ path: 'body', message: 'Provide body or isDeleted' }])
    }

    const taskId = new ObjectId(id)
    const { db, comment } = await loadComment(taskId, new ObjectId(commentId))
    if (!comment) return notFoundError('Comment not found')

    const settings = await getBusinessSettingsCollection(db).findOne({ key: 'business' })
    const window = resolveCommentEditWindow(settings)
    const canModerate = auth.permissions?.tasks?.editOthers === true
    const gate = await guardComment(
      canModerate,
      auth.user._id as ObjectId,
      comment,
      window
    )
    if (!gate.ok) return gate.response

    const now = new Date()
    const set: Record<string, unknown> = { updatedAt: now }
    if (parsed.data.body !== undefined) {
      set.body = parsed.data.body
      set.editedAt = now
    }
    if (parsed.data.isDeleted === true) {
      set.isDeleted = true
      set.deletedAt = now
      set.deletedBy = auth.user._id as ObjectId
    } else if (parsed.data.isDeleted === false) {
      // Restoring a deleted comment is Founder-only — the guard above already
      // rejected the author path once isDeleted is true, so reaching here with
      // isDeleted:false means either canModerate or a live comment (no-op).
      if (!canModerate) {
        return errorResponse('Only a Founder can restore a deleted comment', 403, 'FORBIDDEN')
      }
      set.isDeleted = false
      set.deletedAt = null
      set.deletedBy = null
    }

    const comments = getTaskCommentCollection(db)
    await comments.updateOne({ _id: comment._id } as never, { $set: set } as never)
    const updated = (await comments.findOne({ _id: comment._id } as never))!

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: parsed.data.isDeleted === true ? 'task_comment_deleted' : 'task_comment_updated',
      entityType: 'task_comment',
      entityId: comment._id,
      oldValue: { body: comment.body, isDeleted: comment.isDeleted },
      newValue: { body: updated.body, isDeleted: updated.isDeleted },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(taskCommentToJSON(updated))
  } catch (error) {
    console.error('PATCH /api/tasks/[id]/comments/[commentId] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * DELETE /api/tasks/[id]/comments/[commentId]
 *
 * Soft delete. Rewrites the row with `isDeleted: true` and redacts the body
 * on serialisation (see `taskCommentToJSON`) — the physical string stays in
 * MongoDB so the audit story can always be reconstructed, but no read path
 * returns it.
 */
async function __DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('tasks', 'comment')
    const { id, commentId } = await context.params
    if (!isObjectId(id) || !isObjectId(commentId)) {
      return validationError('Invalid id', [
        { path: 'id', message: 'Malformed' },
        { path: 'commentId', message: 'Malformed' },
      ])
    }

    const taskId = new ObjectId(id)
    const { db, comment } = await loadComment(taskId, new ObjectId(commentId))
    if (!comment) return notFoundError('Comment not found')

    const settings = await getBusinessSettingsCollection(db).findOne({ key: 'business' })
    const window = resolveCommentEditWindow(settings)
    const canModerate = auth.permissions?.tasks?.editOthers === true
    const gate = await guardComment(
      canModerate,
      auth.user._id as ObjectId,
      comment,
      window
    )
    if (!gate.ok) return gate.response

    const now = new Date()
    const comments = getTaskCommentCollection(db)
    await comments.updateOne(
      { _id: comment._id } as never,
      {
        $set: {
          isDeleted: true,
          deletedAt: now,
          deletedBy: auth.user._id as ObjectId,
          updatedAt: now,
        },
      } as never
    )
    const updated = (await comments.findOne({ _id: comment._id } as never))!

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'task_comment_deleted',
      entityType: 'task_comment',
      entityId: comment._id,
      oldValue: { body: comment.body },
      newValue: { isDeleted: true },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(taskCommentToJSON(updated))
  } catch (error) {
    console.error('DELETE /api/tasks/[id]/comments/[commentId] failed:', error)
    return handleRouteError(error)
  }
}

export const PATCH = withAuth(__PATCH)
export const DELETE = withAuth(__DELETE)

