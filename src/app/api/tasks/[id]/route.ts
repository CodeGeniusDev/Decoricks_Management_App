import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { getBusinessSettingsCollection } from '@/lib/models/Ledger'
import { resolveCommentEditWindow } from '@/lib/business-policy'
import {
  getTaskActivityCollection,
  getTaskCommentCollection,
  getTaskDocCollection,
  taskToJSON,
  type TaskDoc,
} from '@/lib/models/Tasks'
import { taskUpdateSchema } from '@/lib/schemas/tasks'
import {
  TaskVersionConflictError,
  recordTaskActivity,
  writeTaskWithVersion,
} from '@/lib/task-service'
import { getActor } from '@/lib/current-user'
import { recordAuditEntry } from '@/lib/audit'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)
const badId = () => validationError('Invalid task id', [{ path: 'id', message: 'Malformed id' }])

/**
 * Ownership check.
 *
 * SPEC §4.2: a Partner may edit or archive only tasks they created or are
 * assigned to. The Founder holds `tasks.editOthers` and `tasks.deleteOthers`,
 * which bypasses this entirely. `authorize('tasks','edit')` alone is not
 * enough — the row-level rule lives here so it cannot be forgotten by any
 * new endpoint that mutates tasks.
 */
const canActOnTask = (
  doc: TaskDoc,
  userId: ObjectId,
  canActOnOthers: boolean
): boolean => {
  if (canActOnOthers) return true
  if (doc.createdBy.equals(userId)) return true
  return doc.assigneeIds.some((a) => a.equals(userId))
}

/**
 * GET /api/tasks/[id]
 *
 * Returns the task plus its comments (newest-last) and activity feed
 * (newest-first, capped at 100). The board drawer shows both; keeping them in
 * a single fetch avoids three round-trips every time a card is opened.
 */
async function __GET(_request: NextRequest, context: RouteContext) {
  try {
    await authorize('tasks', 'view')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const _id = new ObjectId(id)
    const doc = await getTaskDocCollection(db).findOne({ _id } as never)
    if (!doc) return notFoundError('Task not found')

    const [comments, activity, settings] = await Promise.all([
      getTaskCommentCollection(db)
        .find({ taskId: _id, isDeleted: false } as never)
        .sort({ createdAt: 1 })
        .toArray(),
      getTaskActivityCollection(db)
        .find({ taskId: _id } as never)
        .sort({ at: -1 })
        .limit(100)
        .toArray(),
      getBusinessSettingsCollection(db).findOne({ key: 'business' }),
    ])

    return successResponse({
      task: taskToJSON(doc),
      comments: comments.map((c) => ({
        _id: c._id?.toString(),
        taskId: c.taskId.toString(),
        authorId: c.authorId.toString(),
        body: c.body,
        editedAt: c.editedAt ?? null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
      activity: activity.map((a) => ({
        _id: a._id?.toString(),
        kind: a.kind,
        actorId: a.actorId.toString(),
        changes: a.changes,
        at: a.at,
      })),
      // Surfaced so the client can grey out Edit/Delete once the window has
      // closed, without a separate round-trip to /api/finance/settings.
      editWindowMinutes: resolveCommentEditWindow(settings),
    })
  } catch (error) {
    console.error('GET /api/tasks/[id] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * PATCH /api/tasks/[id]
 *
 * Version-guarded. `writeTaskWithVersion` throws `TaskVersionConflictError`
 * with the current document attached, which becomes a 409 response body so
 * the client can show "someone moved this card" and refresh.
 *
 * Column moves go through `/api/tasks/[id]/move`; this route never touches
 * `columnId` or `position`.
 */
async function __PATCH(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('tasks', 'edit')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const parsed = taskUpdateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }

    const db = await getDatabase()
    const _id = new ObjectId(id)
    const before = await getTaskDocCollection(db).findOne({ _id } as never)
    if (!before) return notFoundError('Task not found')

    const canEditOthers = auth.permissions?.tasks?.editOthers === true
    if (!canActOnTask(before, auth.user._id as ObjectId, canEditOthers)) {
      return errorResponse('You can only edit tasks you created or are assigned to', 403, 'FORBIDDEN')
    }

    const set: Partial<Omit<TaskDoc, '_id' | 'version' | 'createdAt' | 'createdBy'>> = {}
    if (parsed.data.title !== undefined) set.title = parsed.data.title
    if (parsed.data.description !== undefined) set.description = parsed.data.description
    if (parsed.data.priority !== undefined) set.priority = parsed.data.priority
    if (parsed.data.dueDate !== undefined) set.dueDate = parsed.data.dueDate ? new Date(parsed.data.dueDate) : null
    if (parsed.data.assigneeIds !== undefined) {
      set.assigneeIds = parsed.data.assigneeIds.map((a) => new ObjectId(a))
    }
    if (parsed.data.labelIds !== undefined) {
      set.labelIds = parsed.data.labelIds.map((l) => new ObjectId(l))
    }
    if (parsed.data.checklist !== undefined) {
      set.checklist = parsed.data.checklist.map((c) => ({
        _id: c._id ? new ObjectId(c._id) : undefined,
        text: c.text,
        isDone: c.isDone,
        doneAt: c.isDone ? new Date() : null,
        doneBy: c.isDone ? (auth.user._id as ObjectId) : null,
      }))
    }

    let updated: TaskDoc & { _id: ObjectId }
    try {
      updated = await writeTaskWithVersion(db, _id, parsed.data.version, set)
    } catch (error) {
      if (error instanceof TaskVersionConflictError) {
        return errorResponse(error.message, 409, error.code, { current: taskToJSON(error.current) })
      }
      throw error
    }

    const actor = await getActor()
    await recordTaskActivity(db, {
      taskId: _id,
      actorId: actor.id,
      kind: 'edited',
      changes: { fields: Object.keys(set) },
    })

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'task_updated',
      entityType: 'task',
      entityId: _id,
      oldValue: { title: before.title, description: before.description, priority: before.priority },
      newValue: { title: updated.title, description: updated.description, priority: updated.priority },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(taskToJSON(updated))
  } catch (error) {
    console.error('PATCH /api/tasks/[id] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * DELETE /api/tasks/[id] — soft archive only. Sets `isArchived: true` and
 * `archivedAt`; the card disappears from the board but stays in the
 * activity/history trail. Requires `tasks.delete` and the row-level ownership
 * rule (or `deleteOthers`).
 */
async function __DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('tasks', 'delete')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const _id = new ObjectId(id)
    const before = await getTaskDocCollection(db).findOne({ _id } as never)
    if (!before) return notFoundError('Task not found')

    const canDeleteOthers = auth.permissions?.tasks?.deleteOthers === true
    if (!canActOnTask(before, auth.user._id as ObjectId, canDeleteOthers)) {
      return errorResponse('You can only archive tasks you created or are assigned to', 403, 'FORBIDDEN')
    }

    let updated: TaskDoc & { _id: ObjectId }
    try {
      updated = await writeTaskWithVersion(db, _id, before.version, {
        isArchived: true,
        archivedAt: new Date(),
      })
    } catch (error) {
      if (error instanceof TaskVersionConflictError) {
        return errorResponse(error.message, 409, error.code, { current: taskToJSON(error.current) })
      }
      throw error
    }

    const actor = await getActor()
    await recordTaskActivity(db, { taskId: _id, actorId: actor.id, kind: 'archived' })

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'task_archived',
      entityType: 'task',
      entityId: _id,
      oldValue: taskToJSON(before),
      newValue: taskToJSON(updated),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse({ _id: id, isArchived: true })
  } catch (error) {
    console.error('DELETE /api/tasks/[id] failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const PATCH = withAuth(__PATCH)
export const DELETE = withAuth(__DELETE)

