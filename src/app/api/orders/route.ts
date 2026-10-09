import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { getOrderCollection, ensureOrdersIndexes, orderToJSON, type Order } from '@/lib/models/Sales'
import { orderSchema } from '@/lib/schemas/operations'
import { priceOrderItems } from '@/lib/order-pricing'
import { getKarachiDate } from '@/lib/date'
import { getActor } from '@/lib/current-user'
import { errorResponse, successResponse, validationError } from '@/lib/api-response'

const isDuplicateKeyError = (e: unknown) => (e as { code?: number })?.code === 11000

/** Builds `SO-YYYYMM-NNNN` from the highest existing number in the month. */
async function nextOrderNumber(col: ReturnType<typeof getOrderCollection>): Promise<string> {
  const now = getKarachiDate()
  const prefix = `SO-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`

  for (let attempt = 0; attempt < 5; attempt++) {
    const highest = await col
      .find({ orderNumber: { $regex: `^${prefix}-` } })
      .sort({ orderNumber: -1 })
      .limit(1)
      .toArray()
    const last = highest[0]?.orderNumber
    const seq = last ? parseInt(last.slice(prefix.length + 1), 10) + 1 : 1
    const candidate = `${prefix}-${String(seq).padStart(4, '0')}`
    if (!(await col.findOne({ orderNumber: candidate }))) return candidate
  }

  throw new Error('Could not allocate a unique order number')
}

/**
 * GET /api/orders
 *
 * Query params: search (order number or customer), status, paymentStatus,
 * channel, page, limit. Every figure is derived from stored documents.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('sales', 'view')

    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')?.trim()
    const status = searchParams.get('status')?.trim()
    const paymentStatus = searchParams.get('paymentStatus')?.trim()
    const channel = searchParams.get('channel')?.trim()
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50', 10) || 50))

    const db = await getDatabase()
    const col = getOrderCollection(db)

    const filter: Record<string, unknown> = {}
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      filter.$or = [
        { orderNumber: { $regex: safe, $options: 'i' } },
        { customerName: { $regex: safe, $options: 'i' } },
      ]
    }
    if (status) filter.orderStatus = status
    if (paymentStatus) filter.paymentStatus = paymentStatus
    if (channel) filter.salesChannel = channel

    const [docs, total] = await Promise.all([
      col.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      col.countDocuments(filter),
    ])

    return successResponse({
      orders: docs.map(orderToJSON),
      pagination: { page, limit, total },
    })
  } catch (error) {
    console.error('GET /api/orders failed:', error)
    return handleRouteError(error)
  }
}

/**
 * POST /api/orders
 *
 * Subtotal and total are always recomputed from the submitted items — the
 * client cannot set monetary totals.
 */
async function __POST(request: NextRequest) {
  try {
    await authorize('sales', 'create')

    const body = await request.json()
    const parsed = orderSchema.safeParse(body)
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const db = await getDatabase()
    const col = getOrderCollection(db)
    await ensureOrdersIndexes(db)

    const now = getKarachiDate()
    const shippingCost = parsed.data.shippingCost ?? 0

    // Product name and unit price are resolved from the database, never taken
    // from the request body — otherwise a stale or tampered client could record
    // an order at an invented name and price.
    const priced = await priceOrderItems(parsed.data.items, db)
    if (!priced.ok) return priced.response
    const items = priced.items
    const subtotal = items.reduce((sum, i) => sum + i.total, 0)

    const actor = await getActor()
    const base = {
      customerName: parsed.data.customerName,
      customerPhone: parsed.data.customerPhone,
      customerCity: parsed.data.customerCity,
      customerAddress: parsed.data.customerAddress,
      items,
      subtotal,
      shippingCost,
      total: subtotal + shippingCost,
      paymentMethod: parsed.data.paymentMethod,
      paymentStatus: parsed.data.paymentStatus,
      orderStatus: parsed.data.orderStatus,
      codOutcome: parsed.data.codOutcome,
      salesChannel: parsed.data.salesChannel,
      notes: parsed.data.notes || undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.id,
    }

    // Two attempts: a unique-index race can lose the number allocation.
    for (let attempt = 0; attempt < 2; attempt++) {
      const orderNumber = await nextOrderNumber(col)
      try {
        const result = await col.insertOne({ ...base, orderNumber } as never)
        return successResponse(orderToJSON({ ...(base as unknown as Order), _id: result.insertedId, orderNumber }), 201)
      } catch (error) {
        if (isDuplicateKeyError(error) && attempt === 0) continue
        throw error
      }
    }

    throw new Error('Order creation failed after retry')
  } catch (error) {
    console.error('POST /api/orders failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
