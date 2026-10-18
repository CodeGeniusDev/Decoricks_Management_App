import { NextRequest } from 'next/server'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { successResponse, validationError } from '@/lib/api-response'
import { recordAuditEntry } from '@/lib/audit'
import { ensureDistributionIndexes, getProfitDistributionCollection } from '@/lib/models/Distribution'
import { buildDistribution, distributionNumberFor, karachiMonthRangeForMonth, serializeDistribution } from '@/lib/distribution-service'
import { distributionCreateSchema } from '@/lib/schemas/distribution'
import { notifyPendingApproval } from '@/lib/notifications/events'

const isDuplicateKeyError = (e: unknown) => (e as { code?: number })?.code === 11000

/**
 * GET /api/finance/distributions
 *
 * Every monthly distribution, newest month first. Reads require
 * `finance.view` (SPEC §4.2 — all roles see the numbers; only the Founder
 * ever writes them).
 */
async function __GET() {
  try {
    await authorize('finance', 'view')
    const db = await getDatabase()
    await ensureDistributionIndexes(db)

    const docs = await getProfitDistributionCollection(db)
      .find({})
      .sort({ periodStart: -1 })
      .toArray()

    return successResponse(docs.map(serializeDistribution))
  } catch (error) {
    console.error('GET /api/finance/distributions failed:', error)
    return handleRouteError(error)
  }
}

/**
 * POST /api/finance/distributions  { month: 'YYYY-MM' }
 *
 * Runs the month's distribution: P&L snapshot from the ledger, split per the
 * configured policy. The record starts as `calculated` — an explicit proposal
 * the Founder must approve to lock. This is never automated: it only exists
 * because a Founder pressed the button, and pressing it twice for the same
 * month replays the first result rather than creating a second record.
 */
async function __POST(request: NextRequest) {
  try {
    const auth = await authorize('finance', 'approve')

    const parsed = distributionCreateSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const { month } = parsed.data
    const range = karachiMonthRangeForMonth(month)
    if (!range) {
      return validationError('Invalid month', [{ path: 'month', message: 'Month must be YYYY-MM' }])
    }

    const db = await getDatabase()
    await ensureDistributionIndexes(db)
    const col = getProfitDistributionCollection(db)

    const existing = await col.findOne({ periodStart: range.start, periodEnd: range.end })
    if (existing) return successResponse(serializeDistribution(existing))

    if (parsed.data.idempotencyKey) {
      const byKey = await col.findOne({ idempotencyKey: parsed.data.idempotencyKey })
      if (byKey) return successResponse(serializeDistribution(byKey))
    }

    const fresh = await buildDistribution(db, month)
    if (!fresh) {
      return validationError('Invalid month', [{ path: 'month', message: 'Month must be YYYY-MM' }])
    }

    const now = new Date()
    const { entryCount: _entryCount, ...snapshot } = fresh
    const doc = {
      ...snapshot,
      distributionNumber: distributionNumberFor(month),
      status: 'calculated' as const,
      idempotencyKey: parsed.data.idempotencyKey || undefined,
      createdBy: auth.user._id!,
      createdAt: now,
      updatedAt: now,
    }

    try {
      const result = await col.insertOne(doc as never)
      const inserted = await col.findOne({ _id: result.insertedId })

      const meta = await getRequestMeta()
      await recordAuditEntry(db, {
        userId: auth.user._id!,
        userEmail: auth.user.email,
        action: 'profit_distribution_calculated',
        entityType: 'finance',
        entityId: result.insertedId,
        newValue: {
          month,
          netProfit: fresh.netProfit,
          charityShare: fresh.charityShare.amount,
          reinvestment: fresh.reinvestmentAmount,
          retainedEarnings: fresh.retainedEarnings,
        },
        details: `Distribution ${doc.distributionNumber} calculated from ${fresh.entryCount} ledger entries`,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })

      // Phase 9: a freshly calculated distribution is now awaiting the Founder's
      // approval — a pending-approval event. Best-effort, swallowed.
      try {
        await notifyPendingApproval(db, {
          entityType: 'distribution',
          entityId: result.insertedId.toString(),
          label: `Distribution ${doc.distributionNumber} for ${month}`,
        })
      } catch (notifyError) {
        console.error('POST /api/finance/distributions notification failed:', notifyError)
      }

      return successResponse(serializeDistribution(inserted!), 201)
    } catch (error) {
      // Concurrent double-run: the unique period index keeps one record.
      if (isDuplicateKeyError(error)) {
        const winner = await col.findOne({ periodStart: range.start, periodEnd: range.end })
        if (winner) return successResponse(serializeDistribution(winner))
      }
      throw error
    }
  } catch (error) {
    console.error('POST /api/finance/distributions failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
