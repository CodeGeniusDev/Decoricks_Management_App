import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { ensureInventoryIndexes, movementToJSON, type StockMovement } from '@/lib/models/Inventory'
import { getProductCollection } from '@/lib/models/Product'
import { successResponse } from '@/lib/api-response'
import { karachiDateInputRange } from '@/lib/finance'
import { isMovementType } from '@/lib/stock-math'

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)

/**
 * GET /api/stock/movements
 *
 * The append-only movement ledger with filters and pagination. This is the
 * read-side audit trail of every physical stock change: purchase in, sale out,
 * return restock/damaged/write-off, damage, write-off, adjustment and
 * transfer, plus linked reversal corrections.
 *
 * Query params: productId, movementType, location (either leg), from/to
 * (YYYY-MM-DD Karachi day boundaries), referenceType, referenceId, page, limit.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('inventory', 'view')

    const { searchParams } = new URL(request.url)
    const page = Math.max(1, Number(searchParams.get('page') ?? 1) || 1)
    const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit') ?? 50) || 50))

    const db = await getDatabase()
    await ensureInventoryIndexes(db)

    const and: Record<string, unknown>[] = []

    const productId = searchParams.get('productId')
    if (productId && isObjectId(productId)) and.push({ productId: new ObjectId(productId) })

    const movementType = searchParams.get('movementType')
    if (movementType && isMovementType(movementType)) and.push({ movementType })

    const location = searchParams.get('location')
    if (location) and.push({ $or: [{ fromLocation: location }, { toLocation: location }] })

    const referenceType = searchParams.get('referenceType')
    if (referenceType) and.push({ referenceType })

    const referenceId = searchParams.get('referenceId')
    if (referenceId && isObjectId(referenceId)) and.push({ referenceId: new ObjectId(referenceId) })

    const from = searchParams.get('from')
    const to = searchParams.get('to')
    const dateFilter: Record<string, Date> = {}
    if (from) {
      const range = karachiDateInputRange(from)
      if (range) dateFilter.$gte = range.start
    }
    if (to) {
      const range = karachiDateInputRange(to)
      if (range) dateFilter.$lte = range.end
    }
    if (Object.keys(dateFilter).length > 0) and.push({ date: dateFilter })

    const filter = and.length === 0 ? {} : and.length === 1 ? and[0] : { $and: and }
    const col = db.collection<StockMovement>('stockMovements')

    const [total, docs] = await Promise.all([
      col.countDocuments(filter as never),
      col
        .find(filter as never)
        .sort({ date: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
    ])

    // Join product names in one pass so the table is a single request.
    const ids = [...new Set(docs.map((d) => d.productId.toString()))]
    const products = await getProductCollection(db)
      .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } } as never)
      .toArray()
    const nameById = new Map(products.map((p) => [p._id!.toString(), p.name]))

    return successResponse({
      items: docs.map((d) => ({
        ...movementToJSON(d),
        productName: nameById.get(d.productId.toString()) ?? 'Unknown product',
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    })
  } catch (error) {
    console.error('GET /api/stock/movements failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
