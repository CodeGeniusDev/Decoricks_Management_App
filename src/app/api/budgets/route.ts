import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { getDatabase } from '@/lib/mongodb'
import { budgetToJSON, ensureOperationsIndexes, getBudgetCollection } from '@/lib/models/Operations'
import { budgetSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { getActor } from '@/lib/current-user'
import { errorResponse, successResponse, validationError } from '@/lib/api-response'

const isDuplicateKeyError = (e: unknown) => (e as { code?: number })?.code === 11000

/** Builds `BUDGET-YYYYMM-NNNN` from the highest existing number in the month. */
async function nextBudgetNumber(col: ReturnType<typeof getBudgetCollection>): Promise<string> {
  const now = getKarachiDate()
  const prefix = `BUDGET-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`

  for (let attempt = 0; attempt < 5; attempt++) {
    const highest = await col
      .find({ budgetNumber: { $regex: `^${prefix}-` } })
      .sort({ budgetNumber: -1 })
      .limit(1)
      .toArray()
    const last = highest[0]?.budgetNumber
    const seq = last ? parseInt(last.slice(prefix.length + 1), 10) + 1 : 1
    const candidate = `${prefix}-${String(seq).padStart(4, '0')}`
    if (!(await col.findOne({ budgetNumber: candidate }))) return candidate
  }

  throw new Error('Could not allocate a unique budget number')
}

/**
 * GET /api/budgets
 *
 * For each budget the actual spend per category is aggregated from the real
 * `expenses` collection within the budget period, so variance and remaining
 * figures are computed rather than hardcoded. Categories with no expenses show
 * `actual: 0`, which is a true zero, not a placeholder.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('budget', 'view')

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')?.trim()

    const db = await getDatabase()
    const budgets = getBudgetCollection(db)
    const expenses = db.collection('expenses')

    const filter: Record<string, unknown> = {}
    if (status) filter.status = status

    const docs = await budgets.find(filter).sort({ periodStart: -1 }).toArray()

    const withActuals = await Promise.all(
      docs.map(async (b) => {
        const rows = await expenses
          .aggregate([
            {
              $match: {
                date: { $gte: b.periodStart, $lte: new Date(b.periodEnd.getTime() + 86_400_000) },
              },
            },
            { $group: { _id: '$category', total: { $sum: '$amount' } } },
          ])
          .toArray()

        const actualByCategory = new Map<string, number>(rows.map((r) => [r._id as string, r.total as number]))

        const categories = b.categories.map((c) => {
          const actual = actualByCategory.get(c.category) ?? 0
          return {
            ...c,
            actual,
            remaining: c.budgeted - actual,
            percentUsed: c.budgeted > 0 ? Math.round((actual / c.budgeted) * 100) : 0,
          }
        })

        const totalActual = categories.reduce((s, c) => s + c.actual, 0)

        return {
          ...budgetToJSON(b),
          categories,
          totalActual,
          totalRemaining: b.totalBudgeted - totalActual,
          percentUsed: b.totalBudgeted > 0 ? Math.round((totalActual / b.totalBudgeted) * 100) : 0,
        }
      })
    )

    return successResponse(withActuals)
  } catch (error) {
    console.error('GET /api/budgets failed:', error)
    return handleRouteError(error)
  }
}

/** POST /api/budgets */
async function __POST(request: NextRequest) {
  try {
    await authorize('budget', 'create')

    const parsed = budgetSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const periodStart = new Date(parsed.data.periodStart)
    const periodEnd = new Date(parsed.data.periodEnd)
    if (periodEnd < periodStart) {
      return validationError('Invalid period', [
        { path: 'periodEnd', message: 'End date must be on or after the start date' },
      ])
    }

    const duplicateCategories = parsed.data.categories.filter(
      (c, i, all) => all.findIndex((x) => x.category.toLowerCase() === c.category.toLowerCase()) !== i
    )
    if (duplicateCategories.length > 0) {
      return validationError('Duplicate categories', [
        { path: 'categories', message: `Duplicate budget category: "${duplicateCategories[0].category}"` },
      ])
    }

    const db = await getDatabase()
    const col = getBudgetCollection(db)
    await ensureOperationsIndexes(db)
    const now = getKarachiDate()
    const actor = await getActor()

    const base = {
      name: parsed.data.name,
      periodStart,
      periodEnd,
      status: parsed.data.status,
      categories: parsed.data.categories,
      totalBudgeted: parsed.data.categories.reduce((s, c) => s + c.budgeted, 0),
      approvedBy: parsed.data.approvedBy || undefined,
      approvedAt: parsed.data.status === 'draft' ? undefined : now,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.id,
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const budgetNumber = await nextBudgetNumber(col)
      try {
        const result = await col.insertOne({ ...base, budgetNumber } as never)
        return successResponse(budgetToJSON({ ...base, _id: result.insertedId, budgetNumber }), 201)
      } catch (error) {
        if (isDuplicateKeyError(error) && attempt === 0) continue
        throw error
      }
    }

    throw new Error('Budget creation failed after retry')
  } catch (error) {
    console.error('POST /api/budgets failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
