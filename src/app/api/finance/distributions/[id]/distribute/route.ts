import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'
import { recordAuditEntry } from '@/lib/audit'
import { getProfitDistributionCollection } from '@/lib/models/Distribution'
import { serializeDistribution } from '@/lib/distribution-service'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * POST /api/finance/distributions/[id]/distribute
 *
 * Marks an approved (locked) distribution as actually paid out — the final
 * status transition. Like approval it is a human decision, audited, and it
 * never changes any figure.
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
    if (doc.status !== 'approved') {
      return errorResponse(
        doc.status === 'distributed'
          ? 'This distribution has already been marked as distributed'
          : 'A distribution must be approved before it can be marked distributed',
        409,
        'INVALID_STATUS'
      )
    }

    const now = new Date()
    await col.updateOne(
      { _id } as never,
      { $set: { status: 'distributed', distributedAt: now, updatedAt: now } } as never
    )

    const updated = await col.findOne({ _id } as never)

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id!,
      userEmail: auth.user.email,
      action: 'profit_distribution_marked_distributed',
      entityType: 'finance',
      entityId: _id,
      oldValue: { status: doc.status },
      newValue: { status: 'distributed' },
      details: `Distribution ${doc.distributionNumber} for ${doc.month} marked distributed`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    return successResponse(serializeDistribution(updated!))
  } catch (error) {
    console.error('POST /api/finance/distributions/[id]/distribute failed:', error)
    return handleRouteError(error)
  }
}

export const POST = withAuth(__POST)
