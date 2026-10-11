import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { getTaskCollection, taskToJSON } from '@/lib/models/Operations'
import { taskSchema, taskStatusUpdateSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { recordAuditEntry } from '@/lib/audit'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)
const badId = () => validationError('Invalid task id', [{ path: 'id', message: 'Malformed id' }])

/** GET /api/tasks/[id] */
async function __GET(_request: NextRequest, context: RouteContext) {
  try {
    await authorize('tasks', 'view')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const doc = await getTaskCollection(db).findOne({ _id: new ObjectId(id) } as never)
    if (!doc) return notFoundError('Task not found')

    return successResponse(taskToJSON(doc))
  } catch (error) {
    console.error('GET /api/tasks/[id] failed:', error)
    return handleRouteError(error)
  }
}

/** PUT /api/tasks/[id] */
async function __PUT(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('tasks', 'edit')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const parsed = taskSchema.partial().safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const db = await getDatabase()
    const col = getTaskCollection(db)
    const _id = new ObjectId(id)

    const before = await col.findOne({ _id } as never)
    if (!before) return notFoundError('Task not found')

    const result = await col.updateOne(
      { _id } as never,
      {
        $set: {
          ...parsed.data,
          dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : undefined,
          updatedAt: getKarachiDate(),
        },
      } as never
    )
    if (result.matchedCount === 0) return notFoundError('Task not found')

    const updated = await col.findOne({ _id } as never)
    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'task_updated',
      entityType: 'task',
      entityId: _id,
      oldValue: taskToJSON(before),
      newValue: updated ? taskToJSON(updated) : undefined,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    return successResponse(taskToJSON(updated!))
  } catch (error) {
    console.error('PUT /api/tasks/[id] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * PATCH /api/tasks/[id]
 *
 * Used by the Kanban column drag/drop to move a task between status columns.
 */
async function __PATCH(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('tasks', 'edit')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const parsed = taskStatusUpdateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const db = await getDatabase()
    const col = getTaskCollection(db)
    const _id = new ObjectId(id)

    const before = await col.findOne({ _id } as never)
    if (!before) return notFoundError('Task not found')

    const result = await col.updateOne(
      { _id } as never,
      { $set: { status: parsed.data.status, updatedAt: getKarachiDate() } } as never
    )
    if (result.matchedCount === 0) return notFoundError('Task not found')

    const updated = await col.findOne({ _id } as never)
    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'task_status_changed',
      entityType: 'task',
      entityId: _id,
      oldValue: { status: before.status },
      newValue: { status: parsed.data.status },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    return successResponse(taskToJSON(updated!))
  } catch (error) {
    console.error('PATCH /api/tasks/[id] failed:', error)
    return handleRouteError(error)
  }
}

/** DELETE /api/tasks/[id] */
async function __DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('tasks', 'delete')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const col = getTaskCollection(db)
    const _id = new ObjectId(id)

    const before = await col.findOne({ _id } as never)
    if (!before) return notFoundError('Task not found')

    const result = await col.deleteOne({ _id } as never)
    if (result.deletedCount === 0) return notFoundError('Task not found')

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'task_deleted',
      entityType: 'task',
      entityId: _id,
      oldValue: taskToJSON(before),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse({ _id: id })
  } catch (error) {
    console.error('DELETE /api/tasks/[id] failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const PUT = withAuth(__PUT)
export const PATCH = withAuth(__PATCH)
export const DELETE = withAuth(__DELETE)
