import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { requireFounder } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import {
  POSITION_GAP,
  columnToJSON,
  getBoardCollection,
  getColumnCollection,
} from '@/lib/models/Tasks'
import { columnCreateSchema } from '@/lib/schemas/tasks'
import { getActor } from '@/lib/current-user'
import { recordAuditEntry } from '@/lib/audit'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)

/**
 * POST /api/boards/[id]/columns — Founder only. Adds a new column to a board.
 *
 * `afterColumnId` positions the new column immediately after the named one;
 * omitting it appends at the end. We do not renumber neighbours: sparse gaps
 * of `POSITION_GAP` (1024) mean a handful of inserts never collide, and the
 * task-service already reflows when a column's task positions get tight.
 */
async function __POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireFounder()

    const { id } = await context.params
    if (!isObjectId(id)) return validationError('Invalid board id', [{ path: 'id', message: 'Malformed' }])

    const parsed = columnCreateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }
    if (parsed.data.boardId !== id) {
      return validationError('boardId mismatch', [{ path: 'boardId', message: 'Does not match URL' }])
    }

    const db = await getDatabase()
    const boardId = new ObjectId(id)
    const board = await getBoardCollection(db).findOne({ _id: boardId } as never)
    if (!board) return notFoundError('Board not found')

    const columns = getColumnCollection(db)
    const actor = await getActor()

    // Compute the new column's ordinal. Append by default; insert-after when
    // the client named an anchor. We do not renumber siblings — the neighbours
    // simply have a smaller gap than usual, which is fine until <2.
    const anchorId = parsed.data.afterColumnId
    let position: number
    if (anchorId) {
      const anchor = await columns.findOne({ _id: new ObjectId(anchorId), boardId } as never)
      if (!anchor) return validationError('Unknown column', [{ path: 'afterColumnId', message: 'Not in this board' }])
      const next = await columns
        .find({ boardId, position: { $gt: anchor.position } } as never)
        .sort({ position: 1 })
        .limit(1)
        .toArray()
      position = next.length > 0
        ? Math.floor((anchor.position + next[0].position) / 2)
        : anchor.position + POSITION_GAP
    } else {
      const last = await columns
        .find({ boardId } as never)
        .sort({ position: -1 })
        .limit(1)
        .toArray()
      position = last.length > 0 ? last[0].position + POSITION_GAP : POSITION_GAP
    }

    const now = new Date()
    const doc = {
      boardId,
      name: parsed.data.name,
      position,
      isDoneColumn: parsed.data.isDoneColumn ?? false,
      isArchived: false,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    }
    const result = await columns.insertOne(doc as never)

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'column_created',
      entityType: 'column',
      entityId: result.insertedId,
      newValue: { boardId: id, name: doc.name, isDoneColumn: doc.isDoneColumn },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(columnToJSON({ ...doc, _id: result.insertedId } as never), 201)
  } catch (error) {
    console.error('POST /api/boards/[id]/columns failed:', error)
    return handleRouteError(error)
  }
}

export const POST = withAuth(__POST)
