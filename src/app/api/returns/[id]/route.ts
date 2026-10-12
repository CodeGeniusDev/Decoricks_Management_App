import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import {
  getReturnCollection,
  getOrderCollection,
  ensureOrdersIndexes,
  returnToJSON,
  orderToJSON,
} from '@/lib/models/Sales'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)

/** GET /api/returns/[id] — one return with its order snapshot attached. */
async function __GET(_request: NextRequest, context: RouteContext) {
  try {
    await authorize('sales', 'view')

    const { id } = await context.params
    if (!isObjectId(id)) {
      return validationError('Invalid return id', [{ path: 'id', message: 'Malformed id' }])
    }

    const db = await getDatabase()
    await ensureOrdersIndexes(db)
    const doc = await getReturnCollection(db).findOne({ _id: new ObjectId(id) } as never)
    if (!doc) return notFoundError('Return not found')

    const order = await getOrderCollection(db).findOne({ _id: doc.orderId } as never)

    return successResponse({
      ...returnToJSON(doc),
      orderNumber: order?.orderNumber ?? null,
      order: order ? orderToJSON(order) : undefined,
    })
  } catch (error) {
    console.error('GET /api/returns/[id] failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
