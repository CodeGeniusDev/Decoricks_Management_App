import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize, requireFounder } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import {
  boardToJSON,
  getBoardCollection,
  ensureTaskIndexes,
  type Board,
} from '@/lib/models/Tasks'
import { boardCreateSchema } from '@/lib/schemas/tasks'
import { createBoardWithDefaults } from '@/lib/task-service'
import { getActor } from '@/lib/current-user'
import { recordAuditEntry } from '@/lib/audit'
import { errorResponse, successResponse, validationError } from '@/lib/api-response'

/**
 * Board collection endpoints.
 *
 *   GET  /api/boards   — every active board plus a task count. Anyone with
 *                        `tasks.view` can read the list; the board itself is
 *                        not a privacy boundary, tasks are.
 *   POST /api/boards   — Founder-only. Creates the board and seeds its four
 *                        default columns (To Do / In Progress / Review / Done)
 *                        atomically through `createBoardWithDefaults`.
 */

async function __GET() {
  try {
    await authorize('tasks', 'view')
    const db = await getDatabase()
    await ensureTaskIndexes(db)

    const boards = await getBoardCollection(db)
      .find({ isActive: true } as never)
      .sort({ createdAt: 1 })
      .toArray()

    // One grouped count query instead of N round-trips per board.
    const counts = await db
      .collection('tasks')
      .aggregate<{ _id: ObjectId; total: number }>([
        { $match: { isArchived: { $ne: true } } },
        { $group: { _id: '$boardId', total: { $sum: 1 } } },
      ])
      .toArray()
    const countByBoard = new Map(counts.map((c) => [c._id.toString(), c.total]))

    return successResponse({
      boards: boards.map((b) => ({
        ...boardToJSON(b),
        taskCount: countByBoard.get(b._id!.toString()) ?? 0,
      })),
    })
  } catch (error) {
    console.error('GET /api/boards failed:', error)
    return handleRouteError(error)
  }
}

async function __POST(request: NextRequest) {
  try {
    const auth = await requireFounder()
    const parsed = boardCreateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }

    const db = await getDatabase()
    const actor = await getActor()

    // Idempotency: a replayed POST returns the board that was created the
    // first time rather than building a duplicate.
    if (parsed.data.idempotencyKey) {
      const existing = await getBoardCollection(db).findOne({
        idempotencyKey: parsed.data.idempotencyKey,
      } as never)
      if (existing) return successResponse(boardToJSON(existing))
    }

    const board = await createBoardWithDefaults(db, {
      name: parsed.data.name,
      description: parsed.data.description,
      createdBy: actor.id,
    })

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'board_created',
      entityType: 'board',
      entityId: board._id,
      newValue: { name: board.name, description: board.description },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(boardToJSON(board), 201)
  } catch (error) {
    console.error('POST /api/boards failed:', error)
    if (error instanceof Error && error.name === 'MongoServerError' && (error as { code?: number }).code === 11000) {
      return errorResponse('Board already exists', 409, 'CONFLICT')
    }
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)

export type { Board }
