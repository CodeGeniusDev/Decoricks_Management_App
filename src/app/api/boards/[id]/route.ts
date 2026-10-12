import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize, requireFounder } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import {
  boardToJSON,
  columnToJSON,
  getBoardCollection,
  getColumnCollection,
  getTaskDocCollection,
  taskToJSON,
} from '@/lib/models/Tasks'
import { boardUpdateSchema } from '@/lib/schemas/tasks'
import { recordAuditEntry } from '@/lib/audit'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)
const badId = () => validationError('Invalid board id', [{ path: 'id', message: 'Malformed id' }])

/**
 * GET /api/boards/[id]
 *
 * Fetches one board with its columns and every non-archived task grouped by
 * column. Browsers hit this once on `/tasks` load and again on focus /
 * reconnect; the response is small enough that we do not paginate here. The
 * filtered list endpoints (`/api/tasks?...`) cover the "My tasks" /
 * "Overdue" views instead.
 */
async function __GET(_request: NextRequest, context: RouteContext) {
  try {
    await authorize('tasks', 'view')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const board = await getBoardCollection(db).findOne({ _id: new ObjectId(id) } as never)
    if (!board) return notFoundError('Board not found')

    const columns = await getColumnCollection(db)
      .find({ boardId: board._id, isArchived: false } as never)
      .sort({ position: 1 })
      .toArray()

    const tasks = await getTaskDocCollection(db)
      .find({ boardId: board._id, isArchived: false } as never)
      .sort({ position: 1 })
      .toArray()

    const byColumn = new Map<string, ReturnType<typeof taskToJSON>[]>()
    for (const c of columns) byColumn.set(c._id!.toString(), [])
    for (const t of tasks) {
      const list = byColumn.get(t.columnId.toString())
      if (list) list.push(taskToJSON(t))
    }

    return successResponse({
      board: boardToJSON(board),
      columns: columns.map(columnToJSON),
      tasksByColumn: Object.fromEntries(byColumn),
    })
  } catch (error) {
    console.error('GET /api/boards/[id] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * PATCH /api/boards/[id] — Founder only. Renames, rewrites description, or
 * archives (`isActive: false`). Never a hard delete.
 */
async function __PATCH(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireFounder()

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const parsed = boardUpdateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }

    const db = await getDatabase()
    const _id = new ObjectId(id)
    const before = await getBoardCollection(db).findOne({ _id } as never)
    if (!before) return notFoundError('Board not found')

    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (parsed.data.name !== undefined) set.name = parsed.data.name
    if (parsed.data.description !== undefined) set.description = parsed.data.description
    if (parsed.data.isActive !== undefined) {
      set.isActive = parsed.data.isActive
      set.archivedAt = parsed.data.isActive ? null : new Date()
    }

    const updated = await getBoardCollection(db).findOneAndUpdate(
      { _id } as never,
      { $set: set } as never,
      { returnDocument: 'after' }
    )
    if (!updated) return notFoundError('Board not found')

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: parsed.data.isActive === false ? 'board_archived' : 'board_updated',
      entityType: 'board',
      entityId: _id,
      oldValue: boardToJSON(before),
      newValue: boardToJSON(updated),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(boardToJSON(updated))
  } catch (error) {
    console.error('PATCH /api/boards/[id] failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const PATCH = withAuth(__PATCH)
