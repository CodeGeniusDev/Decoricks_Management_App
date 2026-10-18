import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { getDatabase } from '@/lib/mongodb'
import {
  Budget,
  budgetToJSON,
  ensureOperationsIndexes,
  getBudgetCollection,
} from '@/lib/models/Operations'
import { notifyPendingApproval } from '@/lib/notifications/events'
import { budgetSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { getActor } from '@/lib/current-user'
import { successResponse, validationError } from '@/lib/api-response'
import { recordAuditEntry } from '@/lib/audit'
import { karachiDateInputRange } from '@/lib/finance'
import {
  budgetPeriodRange,
  computeBudgetActuals,
  derivePeriodKind,
  validatePeriodKind,
} from '@/lib/budget-actuals'
import { fetchLedgerExpenses, loadBudgetThresholds } from '@/lib/budget-queries'

const isDuplicateKeyError = (e: unknown) => (e as { code?: number })?.code === 11000
const isIdempotencyDuplicate = (e: unknown) =>
  isDuplicateKeyError(e) &&
  !!(e as { keyPattern?: Record<string, unknown> }).keyPattern?.idempotencyKey

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

/** POST /api/budgets — Founder by default (`budget.create` grant). */
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

    // Period dates are Karachi civil days: store the day's Karachi midnight so
    // reporting ranges line up with every other Karachi-boundary in the app.
    const startRange = karachiDateInputRange(parsed.data.periodStart)
    const endRange = karachiDateInputRange(parsed.data.periodEnd)
    if (!startRange || !endRange) {
      return validationError('Invalid period', [
        { path: 'periodStart', message: 'Dates must be valid YYYY-MM-DD values' },
      ])
    }
    const periodStart = startRange.start
    const periodEnd = endRange.start
    if (periodEnd < periodStart) {
      return validationError('Invalid period', [
        { path: 'periodEnd', message: 'End date must be on or after the start date' },
      ])
    }

    const periodKind = parsed.data.periodKind ?? derivePeriodKind(periodStart, periodEnd)
    const kindIssue = validatePeriodKind(periodKind, periodStart, periodEnd)
    if (kindIssue) {
      return validationError('Period mismatch', [{ path: 'periodKind', message: kindIssue }])
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

    // A retried request with the same idempotency key replays the original
    // budget instead of creating a second one.
    if (parsed.data.idempotencyKey) {
      const existing = await col.findOne({ idempotencyKey: parsed.data.idempotencyKey })
      if (existing) return successResponse(budgetToJSON(existing))
    }

    const now = getKarachiDate()
    const actor = await getActor()

    const base = {
      name: parsed.data.name,
      periodKind,
      periodStart,
      periodEnd,
      status: parsed.data.status,
      categories: parsed.data.categories,
      totalBudgeted: parsed.data.categories.reduce((s, c) => s + c.budgeted, 0),
      approvedBy: parsed.data.approvedBy || undefined,
      approvedAt: parsed.data.status === 'draft' ? undefined : now,
      idempotencyKey: parsed.data.idempotencyKey || undefined,
      revisions: [],
      createdAt: now,
      updatedAt: now,
      createdBy: actor.id,
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const budgetNumber = await nextBudgetNumber(col)
      try {
        const result = await col.insertOne({ ...base, budgetNumber } as never)
        const created = { ...base, _id: result.insertedId, budgetNumber }

        const meta = await getRequestMeta()
        await recordAuditEntry(db, {
          userId: auth.user._id as typeof base.createdBy,
          userEmail: auth.user.email,
          action: 'budget_created',
          entityType: 'budget',
          entityId: result.insertedId,
          newValue: {
            budgetNumber,
            name: created.name,
            periodKind,
            totalBudgeted: created.totalBudgeted,
            status: created.status,
          },
          details: `Budget ${budgetNumber} created with ${created.categories.length} allocations`,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        })

        // Phase 9: a budget created in `draft` is awaiting the Founder's approval
        // — a pending-approval event. Active budgets need none. Best-effort.
        if (parsed.data.status === 'draft') {
          try {
            await notifyPendingApproval(db, {
              entityType: 'budget',
              entityId: result.insertedId.toString(),
              label: `Budget ${budgetNumber} (${created.name})`,
            })
          } catch (notifyError) {
            console.error('POST /api/budgets notification failed:', notifyError)
          }
        }

        return successResponse(budgetToJSON(created as Budget), 201)
      } catch (error) {
        if (isIdempotencyDuplicate(error) && parsed.data.idempotencyKey) {
          const existing = await col.findOne({ idempotencyKey: parsed.data.idempotencyKey })
          if (existing) return successResponse(budgetToJSON(existing))
        }
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
