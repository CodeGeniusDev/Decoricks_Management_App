import { NextRequest } from 'next/server'
import { ObjectId, type ClientSession, type Db } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize, authorizeStockWrite } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import {
  getOrderCollection,
  ensureOrdersIndexes,
  orderToJSON,
  type Order,
  type OrderItem,
} from '@/lib/models/Sales'
import { ensureInventoryIndexes } from '@/lib/models/Inventory'
import { getProductCollection } from '@/lib/models/Product'
import { orderSchema } from '@/lib/schemas/operations'
import { priceOrderItems } from '@/lib/order-pricing'
import { getKarachiDate } from '@/lib/date'
import { allocateSerial, monthPrefix } from '@/lib/serial'
import { karachiDateInputRange } from '@/lib/finance'
import { recordAuditEntry } from '@/lib/audit'
import { successResponse, validationError } from '@/lib/api-response'
import { ActorContext } from '@/lib/finance-ledger'
import { getAllowNegativeStock, postMovement, runInTransaction } from '@/lib/stock-service'

const isDuplicateKeyError = (e: unknown) => (e as { code?: number })?.code === 11000

/** Builds `SO-YYYYMM-NNNN` from an atomic per-month counter (see lib/serial). */
async function nextOrderNumber(db: Db, session?: ClientSession): Promise<string> {
  return allocateSerial(db, {
    collection: 'orders',
    field: 'orderNumber',
    prefix: monthPrefix('SO'),
    session,
  })
}

/**
 * GET /api/orders
 *
 * Query params: search (order number or customer), status, paymentStatus,
 * channel, location (ship-from), from/to (YYYY-MM-DD Karachi day boundaries
 * on createdAt), page, limit. Every figure is derived from stored documents.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('sales', 'view')

    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')?.trim()
    const status = searchParams.get('status')?.trim()
    const paymentStatus = searchParams.get('paymentStatus')?.trim()
    const channel = searchParams.get('channel')?.trim()
    const location = searchParams.get('location')?.trim()
    const from = searchParams.get('from')?.trim()
    const to = searchParams.get('to')?.trim()
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50', 10) || 50))

    const db = await getDatabase()
    await ensureOrdersIndexes(db)
    const col = getOrderCollection(db)

    const and: Record<string, unknown>[] = []
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      and.push({
        $or: [
          { orderNumber: { $regex: safe, $options: 'i' } },
          { customerName: { $regex: safe, $options: 'i' } },
          { customerPhone: { $regex: safe, $options: 'i' } },
        ],
      })
    }
    if (status) and.push({ orderStatus: status })
    if (paymentStatus) and.push({ paymentStatus })
    if (channel) and.push({ salesChannel: channel })
    if (location) and.push({ shipFromLocation: location })

    const dateFilter: Record<string, Date> = {}
    if (from) {
      const range = karachiDateInputRange(from)
      if (range) dateFilter.$gte = range.start
    }
    if (to) {
      const range = karachiDateInputRange(to)
      if (range) dateFilter.$lte = range.end
    }
    if (Object.keys(dateFilter).length > 0) and.push({ createdAt: dateFilter })

    const filter = and.length === 0 ? {} : and.length === 1 ? and[0] : { $and: and }

    const [docs, total] = await Promise.all([
      col.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      col.countDocuments(filter),
    ])

    return successResponse({
      orders: docs.map(orderToJSON),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    })
  } catch (error) {
    console.error('GET /api/orders failed:', error)
    return handleRouteError(error)
  }
}

/**
 * POST /api/orders — create and reserve stock in one atomic event.
 *
 * Creating an order writes a `sale_out` movement per line at the shipped-from
 * location. That is the reservation: available stock drops immediately, and
 * the decrement is an atomic guarded `$inc` inside a transaction, so two
 * simultaneous sales of the last unit cannot both succeed — the loser gets a
 * 409 and the whole order rolls back. Each movement snapshots the product's
 * weighted-average cost at that moment, which is exactly what COGS is derived
 * from later.
 *
 * The `product_purchasing`-style money leg is deliberately absent: revenue is
 * recognized only when a delivered order's COD cash is confirmed received
 * (PATCH), so nothing can be double counted between order and ledger.
 *
 * STRICT authorization: an order writes stock at one location, so
 * `authorizeStockWrite([shipFromLocation])` runs next to the `sales.create`
 * grant (SPEC §4.2 — Hasnat may write Lahore stock only).
 */
async function __POST(request: NextRequest) {
  try {
    const auth = await authorize('sales', 'create')

    const parsed = orderSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const { shipFromLocation, idempotencyKey } = parsed.data
    await authorizeStockWrite([shipFromLocation])

    const actor: ActorContext = {
      id: auth.user._id as ObjectId,
      name: auth.user.name,
      email: auth.user.email,
    }

    const db = await getDatabase()
    const col = getOrderCollection(db)
    await ensureOrdersIndexes(db)
    await ensureInventoryIndexes(db)

    if (idempotencyKey) {
      const replay = await col.findOne({ idempotencyKey } as never)
      if (replay) return successResponse({ order: orderToJSON(replay), replay: true })
    }

    // Product names and unit prices are resolved from the database, never
    // taken from the request body — a stale or tampered client cannot record
    // an order at an invented name or price.
    const priced = await priceOrderItems(parsed.data.items, db)
    if (!priced.ok) return priced.response
    const items = priced.items
    const subtotal = items.reduce((sum, i) => sum + i.total, 0)
    const shippingCost = parsed.data.shippingCost ?? 0
    const courierCharges = parsed.data.courierCharges ?? 0

    const now = getKarachiDate()
    const allowNegative = await getAllowNegativeStock(db)

    const result = await runInTransaction(async (session) => {
      const orderNumber = await nextOrderNumber(db, session)

      const base: Order = {
        orderNumber,
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
        courierCharges,
        courierName: parsed.data.courierName || undefined,
        salesChannel: parsed.data.salesChannel,
        notes: parsed.data.notes || undefined,
        shipFromLocation,
        idempotencyKey,
        createdAt: now,
        updatedAt: now,
        createdBy: actor.id,
      }

      let orderId: ObjectId
      try {
        const inserted = await col.insertOne(base as never, { session })
        orderId = inserted.insertedId
      } catch (error) {
        if (isDuplicateKeyError(error) && idempotencyKey) {
          const existing = await col.findOne({ idempotencyKey } as never, { session })
          if (existing) return { replayOrder: existing, order: null as Order | null }
        }
        if (isDuplicateKeyError(error)) throw error
        throw error
      }
      base._id = orderId

      // WAC snapshots for the reservation movements are read in-transaction,
      // so the COGS basis matches the stock state the sale was made against.
      const productIds = [...new Set(items.map((i) => i.productId.toString()))]
      const products = await getProductCollection(db)
        .find({ _id: { $in: productIds.map((p) => new ObjectId(p)) } } as never, { session })
        .toArray()
      const costById = new Map(products.map((p) => [p._id!.toString(), p.cost]))

      const lineItems: OrderItem[] = items.map((item) => ({
        ...item,
        unitCost: costById.get(item.productId.toString()) ?? 0,
      }))

      const movementIds: ObjectId[] = []
      for (let i = 0; i < lineItems.length; i++) {
        const item = lineItems[i]
        const { movement } = await postMovement(
          db,
          {
            productId: item.productId,
            movementType: 'sale_out',
            quantity: item.quantity,
            fromLocation: shipFromLocation,
            unitCost: item.unitCost,
            referenceId: orderId,
            referenceType: 'order',
            idempotencyKey: `order:${orderId.toString()}:out:${i}`,
            notes: `Order ${orderNumber}`,
            date: now,
            createdBy: actor.id,
            allowNegative,
          },
          session
        )
        if (movement._id) movementIds.push(movement._id)
      }

      await col.updateOne(
        { _id: orderId } as never,
        { $set: { items: lineItems, stockMovementIds: movementIds } } as never,
        { session }
      )
      base.items = lineItems
      base.stockMovementIds = movementIds

      return { replayOrder: null as Order | null, order: base }
    })

    if (result.replayOrder) {
      return successResponse({ order: orderToJSON(result.replayOrder), replay: true })
    }

    const created = result.order!
    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: actor.id,
      userEmail: actor.email,
      action: 'order_created',
      entityType: 'order',
      entityId: created._id ?? null,
      newValue: orderToJSON(created),
      details: `Order ${created.orderNumber} for ${created.customerName}; reserved stock at ${shipFromLocation}`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    return successResponse({ order: orderToJSON(created), replay: false }, 201)
  } catch (error) {
    console.error('POST /api/orders failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
