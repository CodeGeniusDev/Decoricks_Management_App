import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import {
  getBusinessSettingsCollection,
} from '@/lib/models/Ledger'
import {
  getTaskCommentCollection,
  getTaskDocCollection,
  taskCommentToJSON,
} from '@/lib/models/Tasks'
import { taskCommentCreateSchema } from '@/lib/schemas/tasks'
import { recordTaskActivity } from '@/lib/task-service'
import { resolveCommentEditWindow } from '@/lib/business-policy'
import { getActor } from '@/lib/current-user'
import { recordAuditEntry } from '@/lib/audit'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)

/**
 * GET /api/tasks/[id]/comments
 *
 * List view of the comment thread, oldest first. Soft-deleted comments are
 * included but their `body` is redacted by `taskCommentToJSON`, so a viewer
 * can see "there was a comment here, deleted at T" without the content
 * reappearing. Matches the board drawer timeline.
 */
async function __GET(_request: NextRequest, context: RouteContext) {
  try {
    await authorize('tasks', 'view')

    const { id } = await context.params
    if (!isObjectId(id)) return validationError('Invalid task id', [{ path: 'id', message: 'Malformed' }])

    const db = await getDatabase()
    const taskId = new ObjectId(id)
    const task = await getTaskDocCollection(db).findOne({ _id: taskId } as never)
    if (!task) return notFoundError('Task not found')

    const [comments, settings] = await Promise.all([
      getTaskCommentCollection(db)
        .find({ taskId } as never)
        .sort({ createdAt: 1 })
        .toArray(),
      getBusinessSettingsCollection(db).findOne({ key: 'business' }),
    ])

    return successResponse({
      comments: comments.map(taskCommentToJSON),
      editWindowMinutes: resolveCommentEditWindow(settings),
    })
  } catch (error) {
    console.error('GET /api/tasks/[id]/comments failed:', error)
    return handleRouteError(error)
  }
}

/**
 * POST /api/tasks/[id]/comments
 *
 * Anyone with `tasks.comment` (all four board roles by default) may add a
 * comment on any task they can view — the row-level ownership rule that
 * gates edits and archives deliberately does not apply to comments.
 *
 * The activity entry (`kind: 'commented'`) is written in the same handler so
 * the timeline never drifts from the thread. The comment itself is not
 * versioned; edit-window enforcement lives on the PATCH/DELETE routes.
 */
async function __POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('tasks', 'comment')

    const { id } = await context.params
    if (!isObjectId(id)) return validationError('Invalid task id', [{ path: 'id', message: 'Malformed' }])

    const parsed = taskCommentCreateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }

    const db = await getDatabase()
    const taskId = new ObjectId(id)
    const task = await getTaskDocCollection(db).findOne({ _id: taskId } as never)
    if (!task) return notFoundError('Task not found')

    const now = new Date()
    const doc = {
      taskId,
      authorId: auth.user._id as ObjectId,
      body: parsed.data.body,
      editedAt: null,
      isDeleted: false,
      deletedAt: null,
      deletedBy: null,
      createdAt: now,
      updatedAt: now,
    }
    const insert = await getTaskCommentCollection(db).insertOne(doc as never)

    const actor = await getActor()
    await recordTaskActivity(db, {
      taskId,
      actorId: actor.id,
      kind: 'commented',
      changes: { commentId: insert.insertedId.toString() },
    })

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'task_comment_created',
      entityType: 'task_comment',
      entityId: insert.insertedId,
      newValue: { taskId: id.toString(), body: parsed.data.body },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(
      taskCommentToJSON({ ...doc, _id: insert.insertedId } as never)
    )
  } catch (error) {
    console.error('POST /api/tasks/[id]/comments failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)

