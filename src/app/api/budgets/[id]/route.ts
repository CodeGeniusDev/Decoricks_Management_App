import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import {
  Budget,
  BudgetRevision,
  getBudgetCollection,
  budgetToJSON,
} from '@/lib/models/Operations'
import { budgetUpdateSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'
import { recordAuditEntry } from '@/lib/audit'
import { formatPaisa } from '@/lib/money'
import { computeBudgetActuals, derivePeriodKind } from '@/lib/budget-actuals'
import { fetchLedgerExpenses, loadBudgetThresholds } from '@/lib/budget-queries'
import { karachiDateInputRange } from '@/lib/finance'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)
const badId = () => validationError('Invalid budget id', [{ path: 'id', message: 'Malformed id' }])

/** Budget plus its live actual-vs-budget figures. */
async function detailPayload(db: Awaited<ReturnType<typeof getDatabase>>, doc: Budget) {
  const thresholds = await loadBudgetThresholds(db)
  const range = { start: doc.periodStart, end: doc.periodEnd }
  const entries = await fetchLedgerExpenses(db, range)
  const actuals = computeBudgetActuals(doc, entries, thresholds)
  return {
    ...budgetToJSON(doc),
    periodKind: doc.periodKind ?? null,
    ...actuals,
    revisions: (doc.revisions ?? []).map((r) => ({
      ...r,
      revisedAt: r.revisedAt.toISOString(),
    })),
  }
}

/**
 * GET /api/budgets/[id]
 *
 * Detail view: the budget document, its full revision history and the actual
 * figures recalculated from the ledger on the spot — never read from storage.
 */
async function __GET(_request: NextRequest, context: RouteContext) {
  try {
    await authorize('budget', 'view')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const doc = await getBudgetCollection(db).findOne({ _id: new ObjectId(id) } as never)
    if (!doc) return notFoundError('Budget not found')

    return successResponse(await detailPayload(db, doc))
  } catch (error) {
    console.error('GET /api/budgets/[id] failed:', error)
    return handleRouteError(error)
  }
}

/** Human-readable diff of the fields an edit changed (paisa shown for clarity). */
function diffBudgetCategories(
  previous: Budget['categories'],
  next: Budget['categories']
): string[] {
  const changes: string[] = []
  const prevMap = new Map(previous.map((c) => [c.category, c.budgeted]))
  const nextMap = new Map(next.map((c) => [c.category, c.budgeted]))

  for (const [category, amount] of nextMap) {
    const before = prevMap.get(category)
    if (before === undefined) changes.push(`+${category} ${formatPaisa(amount)}`)
    else if (before !== amount) changes.push(`${category} ${formatPaisa(before)} → ${formatPaisa(amount)}`)
  }
  for (const [category, amount] of prevMap) {
    if (!nextMap.has(category)) changes.push(`−${category} ${formatPaisa(amount)}`)
  }
  return changes
}

/**
 * PUT /api/budgets/[id]
 *
 * Edits keep history: every changed field is diffed into a `BudgetRevision`
 * snapshot of the pre-edit document and the change set goes to the audit log.
 * Status transitions live on the action endpoint, and an archived budget is
 * frozen — history can only ever be appended to.
 */
async function __PUT(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('budget', 'edit')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const parsed = budgetUpdateSchema.safeParse(await request.json().catch(() => null))
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

    const changes: string[] = []
    const next: Budget = { ...existing }

    if (parsed.data.name && parsed.data.name !== existing.name) {
      changes.push(`name "${existing.name}" → "${parsed.data.name}"`)
      next.name = parsed.data.name
    }

    const periodChanged =
      parsed.data.periodStart !== undefined || parsed.data.periodEnd !== undefined
    if (periodChanged) {
      const startRange = karachiDateInputRange(parsed.data.periodStart ?? '')
      const endRange = karachiDateInputRange(parsed.data.periodEnd ?? '')
      if (!startRange && parsed.data.periodStart) {
        return validationError('Invalid period', [{ path: 'periodStart', message: 'Must be YYYY-MM-DD' }])
      }
      if (!endRange && parsed.data.periodEnd) {
        return validationError('Invalid period', [{ path: 'periodEnd', message: 'Must be YYYY-MM-DD' }])
      }
      const nextStart = startRange?.start ?? existing.periodStart
      const nextEnd = endRange?.start ?? existing.periodEnd
      if (nextEnd < nextStart) {
        return validationError('Invalid period', [
          { path: 'periodEnd', message: 'End date must be on or after the start date' },
        ])
      }
      if (
        nextStart.getTime() !== existing.periodStart.getTime() ||
        nextEnd.getTime() !== existing.periodEnd.getTime()
      ) {
        changes.push('period changed')
        next.periodStart = nextStart
        next.periodEnd = nextEnd
        next.periodKind = undefined // re-derived below
      }
    }

    if (parsed.data.categories) {
      const dupes = parsed.data.categories.filter(
        (c, i, all) => all.findIndex((x) => x.category.toLowerCase() === c.category.toLowerCase()) !== i
      )
      if (dupes.length > 0) {
        return validationError('Duplicate categories', [
          { path: 'categories', message: `Duplicate budget category: "${dupes[0].category}"` },
        ])
      }
      const categoryChanges = diffBudgetCategories(existing.categories, parsed.data.categories)
      if (categoryChanges.length > 0) {
        changes.push(...categoryChanges)
        next.categories = parsed.data.categories
        next.totalBudgeted = parsed.data.categories.reduce((s, c) => s + c.budgeted, 0)
      }
    }

    if (changes.length === 0) {
      return successResponse(await detailPayload(db, existing))
    }

    // Re-derive the period kind only when the period itself moved; an explicit
    // kind that no longer matches the new dates would be a silent lie.
    if (next.periodKind === undefined) {
      next.periodKind = derivePeriodKind(next.periodStart, next.periodEnd)
    }

    const actor = { id: auth.user._id!, name: auth.user.name, email: auth.user.email }
    const now = getKarachiDate()
    const revision: BudgetRevision = {
      revisedAt: now,
      revisedBy: actor.id,
      revisedByName: actor.name,
      changes,
      previous: {
        name: existing.name,
        periodStart: existing.periodStart,
        periodEnd: existing.periodEnd,
        status: existing.status,
        categories: existing.categories,
        totalBudgeted: existing.totalBudgeted,
      },
    }

    const result = await col.updateOne(
      { _id } as never,
      {
        $set: {
          name: next.name,
          periodStart: next.periodStart,
          periodEnd: next.periodEnd,
          periodKind: next.periodKind,
          categories: next.categories,
          totalBudgeted: next.totalBudgeted,
          updatedAt: now,
        },
        $push: { revisions: revision } as never,
      } as never
    )
    if (result.matchedCount === 0) return notFoundError('Budget not found')

    const updated = await col.findOne({ _id } as never)

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: actor.id,
      userEmail: actor.email,
      action: 'budget_updated',
      entityType: 'budget',
      entityId: _id,
      oldValue: { name: existing.name, totalBudgeted: existing.totalBudgeted },
      newValue: { name: updated?.name, totalBudgeted: updated?.totalBudgeted },
      details: `Budget ${existing.budgetNumber ?? existing.name}: ${changes.join('; ')}`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(await detailPayload(db, updated!))
  } catch (error) {
    console.error('PUT /api/budgets/[id] failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const PUT = withAuth(__PUT)

/*
 * No DELETE export: budgets are never hard-deleted. Closing one out is the
 * `archive` action on /api/budgets/[id]/action, which keeps the document, the
 * revision history and the audit trail intact. Next.js answers 405 here on
 * its own.
 */
