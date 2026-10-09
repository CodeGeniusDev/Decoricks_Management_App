import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { getBudgetCollection, budgetToJSON } from '@/lib/models/Operations'
import { budgetSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)
const badId = () => validationError('Invalid budget id', [{ path: 'id', message: 'Malformed id' }])

/** GET /api/budgets/[id] */
async function __GET(_request: NextRequest, context: RouteContext) {
  try {
    await authorize('budget', 'view')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const doc = await getBudgetCollection(db).findOne({ _id: new ObjectId(id) } as never)
    if (!doc) return notFoundError('Budget not found')

    return successResponse(budgetToJSON(doc))
  } catch (error) {
    console.error('GET /api/budgets/[id] failed:', error)
    return handleRouteError(error)
  }
}

/** PUT /api/budgets/[id] — recalculates the cached total from the new categories. */
async function __PUT(request: NextRequest, context: RouteContext) {
  try {
    await authorize('budget', 'edit')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const parsed = budgetSchema.partial().safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const db = await getDatabase()
    const col = getBudgetCollection(db)
    const _id = new ObjectId(id)

    const existing = await col.findOne({ _id } as never)
    if (!existing) return notFoundError('Budget not found')
    if (existing.status === 'archived') {
      return validationError('Budget is archived', [
        { path: 'status', message: 'An archived budget cannot be edited' },
      ])
    }

    const nextCategories = parsed.data.categories ?? existing.categories
    const now = getKarachiDate()

    const result = await col.updateOne(
      { _id } as never,
      {
        $set: {
          ...parsed.data,
          periodStart: parsed.data.periodStart ? new Date(parsed.data.periodStart) : undefined,
          periodEnd: parsed.data.periodEnd ? new Date(parsed.data.periodEnd) : undefined,
          totalBudgeted: nextCategories.reduce((s, c) => s + c.budgeted, 0),
          approvedAt: parsed.data.status && parsed.data.status !== 'draft' ? existing.approvedAt ?? now : undefined,
          updatedAt: now,
        },
      } as never
    )
    if (result.matchedCount === 0) return notFoundError('Budget not found')

    const updated = await col.findOne({ _id } as never)
    return successResponse(budgetToJSON(updated!))
  } catch (error) {
    console.error('PUT /api/budgets/[id] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * DELETE /api/budgets/[id]
 *
 * Only draft budgets may be deleted; anything that was actually used against
 * real expenses is deactivated to preserve the reporting trail.
 */
async function __DELETE(_request: NextRequest, context: RouteContext) {
  try {
    await authorize('budget', 'delete')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const col = getBudgetCollection(db)
    const _id = new ObjectId(id)

    const existing = await col.findOne({ _id } as never)
    if (!existing) return notFoundError('Budget not found')

    if (existing.status !== 'draft') {
      await col.updateOne({ _id } as never, { $set: { status: 'archived', updatedAt: getKarachiDate() } } as never)
      const updated = await col.findOne({ _id } as never)
      return successResponse({
        ...budgetToJSON(updated!),
        archived: true,
        message: 'This budget is not a draft, so it was archived instead of deleted.',
      })
    }

    await col.deleteOne({ _id } as never)
    return successResponse({ _id: id })
  } catch (error) {
    console.error('DELETE /api/budgets/[id] failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const PUT = withAuth(__PUT)
export const DELETE = withAuth(__DELETE)
