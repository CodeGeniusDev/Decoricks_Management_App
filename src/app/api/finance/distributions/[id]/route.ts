import { NextRequest } from 'next/server'
import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'
import { ObjectId } from 'mongodb'
import { getProfitDistributionCollection } from '@/lib/models/Distribution'
import { serializeDistribution } from '@/lib/distribution-service'

type RouteContext = { params: Promise<{ id: string }> }

/** GET /api/finance/distributions/[id] — full snapshot with every input figure. */
async function __GET(_request: NextRequest, context: RouteContext) {
  try {
    await authorize('finance', 'view')

    const { id } = await context.params
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      return validationError('Invalid distribution id', [{ path: 'id', message: 'Malformed id' }])
    }

    const db = await getDatabase()
    const doc = await getProfitDistributionCollection(db).findOne({ _id: new ObjectId(id) } as never)
    if (!doc) return notFoundError('Distribution not found')

    return successResponse(serializeDistribution(doc))
  } catch (error) {
    console.error('GET /api/finance/distributions/[id] failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
