import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import {
  POSITION_GAP,
  getBoardCollection,
  getColumnCollection,
  getTaskDocCollection,
  taskToJSON,
  type TaskDoc,
} from '@/lib/models/Tasks'
import { taskCreateSchema, taskListQuerySchema } from '@/lib/schemas/tasks'
import {
  computePosition,
  createTaskNumber,
  recordTaskActivity,
  renumberColumnIfTight,
} from '@/lib/task-service'
import { getActor } from '@/lib/current-user'
import { recordAuditEntry } from '@/lib/audit'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'

/**
 * Board-aware list + create.
 *
 * The old Phase 2 `assigneeName` filter is intentionally gone; `/api/tasks?…`
 * now speaks the board vocabulary (`boardId`, `columnId`, `assigneeId`,
 * `priority`, `labelId`, `dueFrom/dueTo`, `overdue`, `search`). Filters match
 * `taskListQuerySchema` so list, CSV export and weekly summary agree.
 */

const applyQuery = (params: URLSearchParams) => {
  const raw: Record<string, string> = {}
  for (const [k, v] of params.entries()) raw[k] = v
  return taskListQuerySchema.safeParse(raw)
}

async function __GET(request: NextRequest) {
  try {
    await authorize('tasks', 'view')

    const parsed = applyQuery(new URL(request.url).searchParams)
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }
    const q = parsed.data

    const db = await getDatabase()
    const actor = await getActor()

    const filter: Record<string, unknown> = {}
    if (q.includeArchived !== 'true') filter.isArchived = false
    if (q.boardId) filter.boardId = new ObjectId(q.boardId)
    if (q.columnId) filter.columnId = new ObjectId(q.columnId)
    if (q.assigneeId) filter.assigneeIds = new ObjectId(q.assigneeId)
    else if (q.assignee === 'me') filter.assigneeIds = actor.id
    else if (q.assignee) filter.assigneeName = q.assignee // legacy role-label fallback
    if (q.priority) filter.priority = q.priority
    if (q.labelId) filter.labelIds = new ObjectId(q.labelId)
    if (q.dueFrom || q.dueTo) {
      const range: Record<string, Date> = {}
      if (q.dueFrom) range.$gte = new Date(`${q.dueFrom}T00:00:00.000Z`)
      if (q.dueTo) range.$lte = new Date(`${q.dueTo}T23:59:59.999Z`)
      filter.dueDate = range
    }
    if (q.search) {
      const safe = q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      filter.$or = [
        { title: { $regex: safe, $options: 'i' } },
        { taskNumber: { $regex: safe, $options: 'i' } },
      ]
    }
    if (q.overdue === 'true') {
      filter.dueDate = { $lt: new Date(), $ne: null }
      // Exclude tasks in the done column of their board; the caller did not
      // need to name the board for this to be meaningful.
      const doneColumns = await getColumnCollection(db)
        .find({ isDoneColumn: true } as never)
        .project<{ _id: ObjectId }>({ _id: 1 })
        .toArray()
      filter.columnId = { $nin: doneColumns.map((c) => c._id) }
    }

    const skip = (q.page - 1) * q.limit
    const col = getTaskDocCollection(db)
    const [docs, total] = await Promise.all([
      col
        .find(filter as never)
        .sort({ boardId: 1, position: 1 })
        .skip(skip)
        .limit(q.limit)
        .toArray(),
      col.countDocuments(filter as never),
    ])

    return successResponse({
      tasks: docs.map(taskToJSON),
      pagination: { page: q.page, limit: q.limit, total, hasMore: skip + docs.length < total },
    })
  } catch (error) {
    console.error('GET /api/tasks failed:', error)
    return handleRouteError(error)
  }
}

/**
 * POST /api/tasks — create a card.
 *
 * Permission: `tasks.create`. Any partner may create; only the board's column
 * must exist. Idempotency-keyed so a double-click on "Add" produces one card.
 */
async function __POST(request: NextRequest) {
  try {
    const auth = await authorize('tasks', 'create')

    const body = await request.json()
    const parsed = taskCreateSchema.safeParse(body)
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }

    const db = await getDatabase()
    const actor = await getActor()
    const boardId = new ObjectId(parsed.data.boardId)
    const columnId = new ObjectId(parsed.data.columnId)

    const board = await getBoardCollection(db).findOne({ _id: boardId, isActive: true } as never)
    if (!board) return notFoundError('Board not found')
    const column = await getColumnCollection(db).findOne({ _id: columnId, boardId } as never)
    if (!column) return notFoundError('Column not found in this board')

    const col = getTaskDocCollection(db)

    // Idempotent replay: same key returns the original card untouched.
    if (parsed.data.idempotencyKey) {
      const existing = await col.findOne({ idempotencyKey: parsed.data.idempotencyKey } as never)
      if (existing) return successResponse(taskToJSON(existing))
    }

    const position = await computePosition(
      col,
      columnId,
      parsed.data.afterTaskId ? new ObjectId(parsed.data.afterTaskId) : null
    )
    await renumberColumnIfTight(db, columnId)

    const now = new Date()
    const taskNumber = await createTaskNumber(col)
    const doc: Omit<TaskDoc, '_id'> = {
      taskNumber,
      boardId,
      columnId,
      position: position ?? POSITION_GAP,
      title: parsed.data.title,
      description: parsed.data.description,
      assigneeIds: parsed.data.assigneeIds.map((id) => new ObjectId(id)),
      priority: parsed.data.priority,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
      labelIds: parsed.data.labelIds.map((id) => new ObjectId(id)),
      checklist: parsed.data.checklist.map((c) => ({
        _id: c._id ? new ObjectId(c._id) : undefined,
        text: c.text,
        isDone: c.isDone,
        doneAt: c.isDone ? now : null,
        doneBy: c.isDone ? actor.id : null,
      })),
      completedAt: column.isDoneColumn ? now : null,
      completedBy: column.isDoneColumn ? actor.id : null,
      version: 1,
      isArchived: false,
      archivedAt: null,
      idempotencyKey: parsed.data.idempotencyKey,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    }

    const result = await col.insertOne(doc as never)
    const created = { ...doc, _id: result.insertedId } as TaskDoc & { _id: ObjectId }

    await recordTaskActivity(db, {
      taskId: result.insertedId,
      actorId: actor.id,
      kind: 'created',
      changes: { title: doc.title, columnId: columnId.toString() },
    })

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'task_created',
      entityType: 'task',
      entityId: result.insertedId,
      newValue: { taskNumber, title: doc.title, columnId: columnId.toString() },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(taskToJSON(created), 201)
  } catch (error) {
    console.error('POST /api/tasks failed:', error)
    if (error instanceof Error && (error as { code?: number }).code === 11000) {
      return errorResponse('Duplicate request', 409, 'CONFLICT')
    }
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
