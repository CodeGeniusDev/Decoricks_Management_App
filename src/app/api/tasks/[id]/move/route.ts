import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import {
  getColumnCollection,
  getTaskDocCollection,
  taskToJSON,
} from '@/lib/models/Tasks'
import { taskMoveSchema } from '@/lib/schemas/tasks'
import {
  TaskVersionConflictError,
  computePosition,
  describeMove,
  recordTaskActivity,
  renumberColumnIfTight,
  writeTaskWithVersion,
} from '@/lib/task-service'
import { getActor } from '@/lib/current-user'
import { recordAuditEntry } from '@/lib/audit'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)

/**
 * POST /api/tasks/[id]/move
 *
 * The single mutation the drag-and-drop layer (Phase 6d) and the "Move to…"
 * dropdown (Phase 6c) call. Same shape either way: destination column plus
 * optional `afterTaskId`, guarded by `version`.
 *
 * The service decides whether this is `completed`, `reopened` or plain
 * `moved` based on whether the destination column is the board's done column;
 * `completedAt/completedBy` are set/cleared as part of the same atomic
 * version-bump so the state can never be half-updated.
 */
async function __POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('tasks', 'edit')

    const { id } = await context.params
    if (!isObjectId(id)) return validationError('Invalid task id', [{ path: 'id', message: 'Malformed' }])

    const parsed = taskMoveSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }

    const db = await getDatabase()
    const _id = new ObjectId(id)
    const tasks = getTaskDocCollection(db)
    const before = await tasks.findOne({ _id } as never)
    if (!before) return notFoundError('Task not found')

    // Row-level ownership: a Partner may only move tasks they created or are
    // assigned to. `tasks.editOthers` (Founder) bypasses.
    const canMoveOthers = auth.permissions?.tasks?.editOthers === true
    const owns =
      canMoveOthers ||
      before.createdBy.equals(auth.user._id as ObjectId) ||
      before.assigneeIds.some((a) => a.equals(auth.user._id as ObjectId))
    if (!owns) {
      return errorResponse('You can only move tasks you created or are assigned to', 403, 'FORBIDDEN')
    }

    const toColumnId = new ObjectId(parsed.data.toColumnId)
    const [fromCol, toCol] = await Promise.all([
      getColumnCollection(db).findOne({ _id: before.columnId } as never),
      getColumnCollection(db).findOne({ _id: toColumnId, boardId: before.boardId } as never),
    ])
    if (!toCol) return notFoundError('Destination column not in this board')
    if (toCol.isArchived) return validationError('Column is archived', [{ path: 'toColumnId', message: 'Archived' }])

    const afterId = parsed.data.afterTaskId ? new ObjectId(parsed.data.afterTaskId) : null
    const position = await computePosition(tasks, toColumnId, afterId, _id)
    await renumberColumnIfTight(db, toColumnId)

    const move = describeMove(fromCol ?? null, toCol, auth.user._id as ObjectId)

    let updated
    try {
      updated = await writeTaskWithVersion(db, _id, parsed.data.version, {
        columnId: toColumnId,
        position,
        ...move.set,
      })
    } catch (error) {
      if (error instanceof TaskVersionConflictError) {
        return errorResponse(error.message, 409, error.code, { current: taskToJSON(error.current) })
      }
      throw error
    }

    const actor = await getActor()
    // Always record the physical move; then a completed/reopened entry on top
    // so the timeline shows both the fact of the transition and its meaning.
    await recordTaskActivity(db, {
      taskId: _id,
      actorId: actor.id,
      kind: 'moved',
      changes: {
        fromColumnId: before.columnId.toString(),
        toColumnId: toColumnId.toString(),
        position,
      },
    })
    if (move.activityKind !== 'moved') {
      await recordTaskActivity(db, {
        taskId: _id,
        actorId: actor.id,
        kind: move.activityKind,
        changes: { columnId: toColumnId.toString() },
      })
    }

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: `task_${move.activityKind}`,
      entityType: 'task',
      entityId: _id,
      oldValue: { columnId: before.columnId.toString(), position: before.position },
      newValue: { columnId: toColumnId.toString(), position },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(taskToJSON(updated))
  } catch (error) {
    console.error('POST /api/tasks/[id]/move failed:', error)
    return handleRouteError(error)
  }
}

export const POST = withAuth(__POST)
