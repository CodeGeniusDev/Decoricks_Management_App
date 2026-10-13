import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { requireFounder } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { columnToJSON, getColumnCollection, getTaskDocCollection } from '@/lib/models/Tasks'
import { columnUpdateSchema } from '@/lib/schemas/tasks'
import { recordAuditEntry } from '@/lib/audit'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)

/**
 * PATCH /api/columns/[id] — Founder only. Renames, archives, or flips the
 * `isDoneColumn` flag.
 *
 * Flipping `isDoneColumn: true` demotes the previous done column in the same
 * board and clears `completedAt/completedBy` on the tasks that were "done"
 * under the old scheme, because those fields only have meaning relative to
 * the current done column. Flipping `isDoneColumn: false` on a column simply
 * releases the done role; tasks inside it retain their completion timestamp
 * until a new done column is chosen (SPEC §3.1.15.2).
 */
async function __PATCH(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireFounder()

    const { id } = await context.params
    if (!isObjectId(id))
      return validationError('Invalid column id', [{ path: 'id', message: 'Malformed' }])

    const parsed = columnUpdateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }

    const db = await getDatabase()
    const _id = new ObjectId(id)
    const columns = getColumnCollection(db)
    const before = await columns.findOne({ _id } as never)
    if (!before) return notFoundError('Column not found')

    const now = new Date()
    const set: Record<string, unknown> = { updatedAt: now }
    if (parsed.data.name !== undefined) set.name = parsed.data.name
    if (parsed.data.isArchived !== undefined) set.isArchived = parsed.data.isArchived

    // Only mutate isDoneColumn when the caller actually sent a different value.
    const wantsDone = parsed.data.isDoneColumn
    const willBeDone = wantsDone === undefined ? before.isDoneColumn : wantsDone

    if (wantsDone !== undefined && wantsDone !== before.isDoneColumn) {
      set.isDoneColumn = wantsDone
    }

    const updated = await columns.findOneAndUpdate({ _id } as never, { $set: set } as never, {
      returnDocument: 'after',
    })
    if (!updated) return notFoundError('Column not found')

    // Promote/demote side effects:
    //   * Promoting this column → demote whatever other column was done, then
    //     set completedAt/completedBy on the new done column's tasks that
    //     don't already have them.
    //   * Demoting this column → clear completedAt/completedBy on its tasks.
    if (wantsDone === true && before.isDoneColumn === false) {
      await columns.updateOne(
        { boardId: before.boardId, _id: { $ne: _id }, isDoneColumn: true } as never,
        { $set: { isDoneColumn: false, updatedAt: now } } as never
      )
      await getTaskDocCollection(db).updateMany(
        { columnId: _id, completedAt: null } as never,
        { $set: { completedAt: now, completedBy: auth.user._id as ObjectId } } as never
      )
    } else if (wantsDone === false && before.isDoneColumn === true) {
      await getTaskDocCollection(db).updateMany(
        { columnId: _id } as never,
        { $set: { completedAt: null, completedBy: null } } as never
      )
    }

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: parsed.data.isArchived === true ? 'column_archived' : 'column_updated',
      entityType: 'column',
      entityId: _id,
      oldValue: columnToJSON(before),
      newValue: columnToJSON(updated),
      details: willBeDone === updated.isDoneColumn ? undefined : `done column now ${willBeDone}`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(columnToJSON(updated))
  } catch (error) {
    console.error('PATCH /api/columns/[id] failed:', error)
    return handleRouteError(error)
  }
}

export const PATCH = withAuth(__PATCH)
