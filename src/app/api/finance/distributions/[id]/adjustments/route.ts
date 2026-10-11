import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'
import { recordAuditEntry } from '@/lib/audit'
import { formatPaisa } from '@/lib/money'
import {
  DistributionAdjustment,
  getProfitDistributionCollection,
  isDistributionLocked,
} from '@/lib/models/Distribution'
import { recomputeShares, serializeDistribution } from '@/lib/distribution-service'
import { distributionAdjustmentSchema } from '@/lib/schemas/distribution'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * POST /api/finance/distributions/[id]/adjustments
 *
 * The Founder-created profit-share adjustment record (SPEC §3.1.14): reason
 * required, audit-logged, and the whole month is then re-split from the
 * stored snapshots — deductions are redistributed pro-rata to the other
 * partners per the configured percentages, bonuses come out of retained
 * earnings. Once the distribution is approved it is locked: money that has
 * been signed off is never recomputed.
 */
async function __POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('finance', 'approve')

    const parsed = distributionAdjustmentSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const { id } = await context.params
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      return validationError('Invalid distribution id', [{ path: 'id', message: 'Malformed id' }])
    }

    const db = await getDatabase()
    const col = getProfitDistributionCollection(db)
    const _id = new ObjectId(id)

    const doc = await col.findOne({ _id } as never)
    if (!doc) return notFoundError('Distribution not found')
    if (isDistributionLocked(doc)) {
      return errorResponse(
        'This distribution is approved and locked; adjustments can no longer change it',
        409,
        'DISTRIBUTION_LOCKED'
      )
    }

    const { partnerName, amount, reason } = parsed.data
    const index = doc.partnerShares.findIndex(
      (share) => share.partnerName.trim().toLowerCase() === partnerName.trim().toLowerCase()
    )
    if (index === -1) {
      return validationError('Unknown partner', [
        { path: 'partnerName', message: `"${partnerName}" is not a partner in this distribution` },
      ])
    }

    const adjustment: DistributionAdjustment = {
      amount,
      reason,
      adjustedBy: auth.user._id!,
      adjustedByName: auth.user.name,
      adjustedAt: new Date(),
    }

    const nextShares = doc.partnerShares.map((share, i) =>
      i === index ? { ...share, adjustments: [...share.adjustments, adjustment] } : share
    )
    const recomputed = recomputeShares({ ...doc, partnerShares: nextShares })

    const totals = recomputed.reduce(
      (acc, share) => {
        acc.reinvested += share.reinvestedAmount
        acc.final += share.finalAmount
        return acc
      },
      { reinvested: 0, final: 0 }
    )
    const retainedEarnings = doc.netProfit - doc.charityShare.amount - totals.final

    await col.updateOne(
      { _id } as never,
      {
        $set: {
          partnerShares: recomputed,
          reinvestmentAmount: totals.reinvested,
          retainedEarnings,
          updatedAt: new Date(),
        },
      } as never
    )

    const updated = await col.findOne({ _id } as never)

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id!,
      userEmail: auth.user.email,
      action: 'profit_share_adjusted',
      entityType: 'finance',
      entityId: _id,
      oldValue: { partnerName, finalAmount: doc.partnerShares[index].finalAmount },
      newValue: {
        partnerName,
        finalAmount: recomputed[index].finalAmount,
        amount,
        reason,
      },
      details: `${partnerName}: ${formatPaisa(amount)} (${reason})`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(serializeDistribution(updated!))
  } catch (error) {
    console.error('POST /api/finance/distributions/[id]/adjustments failed:', error)
    return handleRouteError(error)
  }
}

export const POST = withAuth(__POST)
