import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { getDatabase } from '@/lib/mongodb'
import { budgetToJSON, getBudgetCollection } from '@/lib/models/Operations'
import { budgetSchema } from '@/lib/schemas/operations'
import { getActor } from '@/lib/current-user'
import { successResponse, validationError } from '@/lib/api-response'
import { createBudget } from '@/lib/budget-create'
import {
  budgetPeriodRange,
  computeBudgetActuals,
  derivePeriodKind,
} from '@/lib/budget-actuals'
import { fetchLedgerExpenses, loadBudgetThresholds } from '@/lib/budget-queries'

/**
 * GET /api/budgets
 *
 * Actuals are CALCULATED, never stored: every budget's spend per category is
 * recomputed live from the unified ledger (`transactions`) inside the budget
 * period, with reversals counted as negatives and threshold levels from the
 * configurable business settings. One ledger read serves the whole list.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('budget', 'view')

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')?.trim()

    const db = await getDatabase()
    const budgets = getBudgetCollection(db)

    const filter: Record<string, unknown> = {}
    if (status) filter.status = status

    const docs = await budgets.find(filter).sort({ periodStart: -1 }).toArray()
    const thresholds = await loadBudgetThresholds(db)

    let entries: Awaited<ReturnType<typeof fetchLedgerExpenses>> = []
    if (docs.length > 0) {
      const windowStart = new Date(Math.min(...docs.map((d) => d.periodStart.getTime())))
      const windowEnd = new Date(Math.max(...docs.map((d) => d.periodEnd.getTime())))
      const range = budgetPeriodRange(windowStart, windowEnd)
      entries = await fetchLedgerExpenses(db, range)
    }

    const withActuals = docs.map((b) => {
      const actuals = computeBudgetActuals(b, entries, thresholds)
      return {
        ...budgetToJSON(b),
        periodKind: b.periodKind ?? derivePeriodKind(b.periodStart, b.periodEnd),
        ...actuals,
      }
    })

    return successResponse(withActuals)
  } catch (error) {
    console.error('GET /api/budgets failed:', error)
    return handleRouteError(error)
  }
}

/**
 * POST /api/budgets — Founder by default (`budget.create` grant).
 *
 * Thin HTTP shell: authorize, zod-parse, then delegate to `createBudget`
 * (`src/lib/budget-create.ts`) — the SAME engine the offline sync route runs,
 * so online and offline creates can never drift (design §6.4, METRICS §H.2).
 * `createBudget` throws HttpError for business rejections; `handleRouteError`
 * renders the identical envelope the inline code used to return by hand.
 */
async function __POST(request: NextRequest) {
  try {
    const auth = await authorize('budget', 'create')

    const parsed = budgetSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const db = await getDatabase()
    const meta = await getRequestMeta()
    const actor = await getActor()

    const { budget, created } = await createBudget(db, parsed.data, {
      id: actor.id,
      name: actor.name,
      email: auth.user.email,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(budgetToJSON(budget), created ? 201 : 200)
  } catch (error) {
    console.error('POST /api/budgets failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
