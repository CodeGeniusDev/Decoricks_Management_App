/**
 * Budget creation — the ONE write engine (design §6.4, METRICS §H.2).
 *
 * Extracted verbatim from `POST /api/budgets` so the offline sync route can
 * delegate to the SAME code the online form runs: same period math, same
 * duplicate-category rule, same number allocation, same idempotency replay,
 * same audit and pending-approval notification. "Offline behaves what it does
 * online" is structural, not a re-implementation that can drift.
 */

import { ObjectId, type Collection, type Db } from 'mongodb'
import { getKarachiDate } from '@/lib/date'
import { karachiDateInputRange } from '@/lib/finance'
import { HttpError } from '@/lib/http'
import { recordAuditEntry } from '@/lib/audit'
import { derivePeriodKind, validatePeriodKind } from '@/lib/budget-actuals'
import { notifyPendingApproval } from '@/lib/notifications/events'
import {
  budgetToJSON,
  ensureOperationsIndexes,
  getBudgetCollection,
  type Budget,
} from '@/lib/models/Operations'
import type { budgetSchema } from '@/lib/schemas/operations'
import { z } from 'zod'

export type BudgetCreateInput = z.infer<typeof budgetSchema>

export interface BudgetActor {
  id: ObjectId
  name: string
  email: string
  ipAddress?: string
  userAgent?: string
}

const isDuplicateKeyError = (e: unknown) => (e as { code?: number })?.code === 11000
const isIdempotencyDuplicate = (e: unknown) =>
  isDuplicateKeyError(e) &&
  !!(e as { keyPattern?: Record<string, unknown> }).keyPattern?.idempotencyKey

/** Builds `BUDGET-YYYYMM-NNNN` from the highest existing number in the month. */
async function nextBudgetNumber(col: Collection<Budget>): Promise<string> {
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
 * Create a budget, or replay the original for a known idempotency key.
 * Throws `HttpError(400 VALIDATION_ERROR)` with field issues for anything the
 * UI would have caught — period bounds, derived-kind mismatch, duplicates —
 * so the offline sync route gets the exact same rejection the online form
 * gets and can map it per design §6.5.
 */
export const createBudget = async (
  db: Db,
  input: BudgetCreateInput,
  actor: BudgetActor
): Promise<{ budget: Budget; created: boolean }> => {
  // Period dates are Karachi civil days: store the day's Karachi midnight so
  // reporting ranges line up with every other Karachi-boundary in the app.
  const startRange = karachiDateInputRange(input.periodStart)
  const endRange = karachiDateInputRange(input.periodEnd)
  if (!startRange || !endRange) {
    throw new HttpError('Invalid period', 400, 'VALIDATION_ERROR', [
      { path: 'periodStart', message: 'Dates must be valid YYYY-MM-DD values' },
    ])
  }
  const periodStart = startRange.start
  const periodEnd = endRange.start
  if (periodEnd < periodStart) {
    throw new HttpError('Invalid period', 400, 'VALIDATION_ERROR', [
      { path: 'periodEnd', message: 'End date must be on or after the start date' },
    ])
  }

  const periodKind = input.periodKind ?? derivePeriodKind(periodStart, periodEnd)
  const kindIssue = validatePeriodKind(periodKind, periodStart, periodEnd)
  if (kindIssue) {
    throw new HttpError('Period mismatch', 400, 'VALIDATION_ERROR', [
      { path: 'periodKind', message: kindIssue },
    ])
  }

  const duplicateCategories = input.categories.filter(
    (c, i, all) => all.findIndex((x) => x.category.toLowerCase() === c.category.toLowerCase()) !== i
  )
  if (duplicateCategories.length > 0) {
    throw new HttpError('Duplicate categories', 400, 'VALIDATION_ERROR', [
      {
        path: 'categories',
        message: `Duplicate budget category: "${duplicateCategories[0].category}"`,
      },
    ])
  }

  const col = getBudgetCollection(db)
  await ensureOperationsIndexes(db)

  // A retried request with the same idempotency key replays the original
  // budget instead of creating a second one.
  if (input.idempotencyKey) {
    const existing = await col.findOne({ idempotencyKey: input.idempotencyKey })
    if (existing) return { budget: existing, created: false }
  }

  const now = getKarachiDate()

  const base = {
    name: input.name,
    periodKind,
    periodStart,
    periodEnd,
    status: input.status,
    categories: input.categories,
    totalBudgeted: input.categories.reduce((s, c) => s + c.budgeted, 0),
    approvedBy: input.approvedBy || undefined,
    approvedAt: input.status === 'draft' ? undefined : now,
    idempotencyKey: input.idempotencyKey || undefined,
    revisions: [],
    createdAt: now,
    updatedAt: now,
    createdBy: actor.id,
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const budgetNumber = await nextBudgetNumber(col)
    try {
      const result = await col.insertOne({ ...base, budgetNumber } as never)
      const created = { ...base, _id: result.insertedId, budgetNumber } as Budget

      await recordAuditEntry(db, {
        userId: actor.id,
        userEmail: actor.email,
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
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      })

      // Phase 9: a budget created in `draft` is awaiting the Founder's approval
      // — a pending-approval event. Active budgets need none. Best-effort.
      if (input.status === 'draft') {
        try {
          await notifyPendingApproval(db, {
            entityType: 'budget',
            entityId: result.insertedId.toString(),
            label: `Budget ${budgetNumber} (${created.name})`,
          })
        } catch (notifyError) {
          console.error('createBudget notification failed:', notifyError)
        }
      }

      return { budget: created, created: true }
    } catch (error) {
      if (isIdempotencyDuplicate(error) && input.idempotencyKey) {
        const existing = await col.findOne({ idempotencyKey: input.idempotencyKey })
        if (existing) return { budget: existing, created: false }
      }
      if (isDuplicateKeyError(error) && attempt === 0) continue
      throw error
    }
  }

  throw new Error('Budget creation failed after retry')
}
