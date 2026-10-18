import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'
import { recordAuditEntry } from '@/lib/audit'
import { getProfitDistributionCollection } from '@/lib/models/Distribution'
import { serializeDistribution } from '@/lib/distribution-service'
import { notifyDistributionLocked } from '@/lib/notifications/events'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * POST /api/finance/distributions/[id]/approve
 *
 * The Founder sign-off that locks a monthly distribution. Deliberately a
 * separate, explicit act — nothing approves automatically — and the record
 * must have been freshly `calculated`. After this, adjustments return 409.
 */
async function __POST(_request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('finance', 'approve')

    const { id } = await context.params
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      return validationError('Invalid distribution id', [{ path: 'id', message: 'Malformed id' }])
    }

    const db = await getDatabase()
    const col = getProfitDistributionCollection(db)
    const _id = new ObjectId(id)

    const doc = await col.findOne({ _id } as never)
    if (!doc) return notFoundError('Distribution not found')
    if (doc.status !== 'calculated') {
      return errorResponse(
        `A ${doc.status} distribution cannot be approved again`,
        409,
        'INVALID_STATUS'
      )
    }

    const now = new Date()
    await col.updateOne(
      { _id } as never,
      {
        $set: {
          status: 'approved',
          approvedBy: auth.user._id!,
          approvedByName: auth.user.name,
          approvedAt: now,
          updatedAt: now,
        },
      } as never
    )

    const updated = await col.findOne({ _id } as never)

    // Phase 9: a locked distribution is an owner-facing financial event. Best-
    // effort and swallowed — the lock already succeeded and is audited; a failed
    // alert must not unwind it or fail the request.
    try {
      await notifyDistributionLocked(db, id, doc.month)
    } catch (notifyError) {
      console.error('POST /api/finance/distributions/[id]/approve notification failed:', notifyError)
    }

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id!,
      userEmail: auth.user.email,
      action: 'profit_distribution_approved',
      entityType: 'finance',
      entityId: _id,
      oldValue: { status: doc.status },
      newValue: { status: 'approved', netProfit: doc.netProfit },
      details: `Distribution ${doc.distributionNumber} for ${doc.month} approved and locked`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(serializeDistribution(updated!))
  } catch (error) {
    console.error('POST /api/finance/distributions/[id]/approve failed:', error)
    return handleRouteError(error)
  }
}

export const POST = withAuth(__POST)
