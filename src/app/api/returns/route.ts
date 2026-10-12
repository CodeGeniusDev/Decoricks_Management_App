import { NextRequest } from 'next/server'
import { ObjectId, type ClientSession, type Db } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize, authorizeStockWrite, requireFounder } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import {
  getOrderCollection,
  getReturnCollection,
  ensureOrdersIndexes,
  returnToJSON,
  orderToJSON,
  type Order,
  type ReturnItemOutcome,
  type ReturnRecord,
} from '@/lib/models/Sales'
import { ensureInventoryIndexes, insertIdempotent } from '@/lib/models/Inventory'
import { getProductCollection, type Location } from '@/lib/models/Product'
import { returnSchema } from '@/lib/schemas/operations'
import { getKarachiDate } from '@/lib/date'
import { allocateSerial, monthPrefix } from '@/lib/serial'
import { karachiDateInputRange } from '@/lib/finance'
import { recordAuditEntry } from '@/lib/audit'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'
import { createLedgerEntry, parseLedgerDate, type ActorContext } from '@/lib/finance-ledger'
import { resolvePostingAccount } from '@/lib/ledger-accounts'
import { getAllowNegativeStock, postMovement, runInTransaction } from '@/lib/stock-service'
import { formatPaisa } from '@/lib/money'

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)

/** Seeded ledger slug (SPEC §5.2: refunds and return costs net sales). */
const REFUND_CATEGORY = 'refunds_return_costs'

/** Movement type per return outcome (SPEC §3.1.5). */
const OUTCOME_MOVEMENT: Record<ReturnItemOutcome, 'return_restock' | 'return_damaged' | 'return_writeoff'> =
  {
    restock: 'return_restock',
    damaged: 'return_damaged',
    writeoff: 'return_writeoff',
  }

/** Builds `RET-YYYYMM-NNNN` from an atomic per-month counter (see lib/serial). */
async function nextReturnNumber(db: Db, session?: ClientSession): Promise<string> {
  return allocateSerial(db, {
    collection: 'returns',
    field: 'returnNumber',
    prefix: monthPrefix('RET'),
    session,
  })
}

/**
 * GET /api/returns
 *
 * Query params: orderId, from, to (YYYY-MM-DD Karachi boundaries), page,
 * limit. Order numbers are joined so the returns screen never shows bare ids.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('sales', 'view')

    const { searchParams } = new URL(request.url)
    const orderId = searchParams.get('orderId')
    const page = Math.max(1, Number(searchParams.get('page') ?? 1) || 1)
    const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit') ?? 50) || 50))

    const db = await getDatabase()
    await ensureOrdersIndexes(db)
    const col = getReturnCollection(db)

    const and: Record<string, unknown>[] = []
    if (orderId && isObjectId(orderId)) and.push({ orderId: new ObjectId(orderId) })

    const dateFilter: Record<string, Date> = {}
    const from = searchParams.get('from')
    const to = searchParams.get('to')
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

    const orderIds = [...new Set(docs.map((r) => r.orderId.toString()))]
    const orders = orderIds.length
      ? await getOrderCollection(db)
          .find({ _id: { $in: orderIds.map((o) => new ObjectId(o)) } } as never)
          .toArray()
      : []
    const orderLabel = new Map(orders.map((o) => [o._id!.toString(), o.orderNumber]))

    return successResponse({
      items: docs.map((r) => ({
        ...returnToJSON(r),
        orderNumber: orderLabel.get(r.orderId.toString()) ?? null,
      })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    })
  } catch (error) {
    console.error('GET /api/returns failed:', error)
    return handleRouteError(error)
  }
}

/**
 * POST /api/returns — a returned parcel becomes stock movements plus ledger
 * entries, in one transaction:
 *
 *   restock   → `return_restock` movement: the unit is sellable again
 *               (SPEC default outcome).
 *   damaged   → `return_damaged`: joins the damaged pool, never available.
 *   write-off → `return_writeoff`: gone; shows only in the returned pool.
 *   refund    → one `refunds_return_costs` expense (nets sales, SPEC §5.2).
 *   courier   → return courier costs as the same expense category.
 *
 * Founder gate: marking an item damaged or writing it off is deliberately a
 * Founder-only outcome — everyone else can only restock. Stock authorization
 * is STRICT on the location the units come back to (the order's ship-from).
 *
 * Quantities are validated against what was ordered minus what previous
 * returns already took back, so a return can never restock units that were
 * never sold — and never twice.
 */
async function __POST(request: NextRequest) {
  try {
    const auth = await authorize('sales', 'create')

    const parsed = returnSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }
    const { orderId, items, outcome, refundAmount, courierCost, accountId, date, notes, idempotencyKey } =
      parsed.data

    const actor: ActorContext = {
      id: auth.user._id as ObjectId,
      name: auth.user.name,
      email: auth.user.email,
    }

    const db = await getDatabase()
    await ensureOrdersIndexes(db)
    await ensureInventoryIndexes(db)

    if (idempotencyKey) {
      const replay = await getReturnCollection(db).findOne({ idempotencyKey } as never)
      if (replay) return successResponse({ return: returnToJSON(replay), replay: true })
    }

    const order = await getOrderCollection(db).findOne({ _id: new ObjectId(orderId) } as never)
    if (!order) return notFoundError('Order not found')

    if (order.orderStatus !== 'delivered' && order.orderStatus !== 'returned') {
      return validationError('Order cannot be returned', [
        {
          path: 'orderId',
          message: `Only delivered or returned orders accept returns (this one is "${order.orderStatus}")`,
        },
      ])
    }
    if (order.codOutcome === 'refused') {
      return validationError('Refused orders restore stock automatically', [
        {
          path: 'orderId',
          message: 'Recording a refusal already restored this order\'s stock; no return is needed',
        },
      ])
    }

    const location = order.shipFromLocation
    if (!location) {
      return validationError('Order has no ship-from location', [
        { path: 'orderId', message: 'This legacy order cannot be returned through the stock ledger' },
      ])
    }

    const itemOutcomes = items.map((i) => i.outcome ?? outcome)
    if (itemOutcomes.some((o) => o !== 'restock')) {
      await requireFounder()
    }

    await authorizeStockWrite([location])

    // Refunds cannot exceed what the customer was charged.
    if (refundAmount > order.total) {
      return validationError('Refund exceeds order total', [
        {
          path: 'refundAmount',
          message: `Maximum refund is ${formatPaisa(order.total)} (the order total)`,
        },
      ])
    }

    // Returnable quantity per product = ordered minus already returned across
    // every previous return record for this order.
    const orderItems = new Map(order.items.map((i) => [i.productId.toString(), i]))
    const previousReturns = await getReturnCollection(db).find({ orderId: order._id } as never).toArray()
    const alreadyReturned = new Map<string, number>()
    for (const r of previousReturns) {
      for (const ri of r.items) {
        alreadyReturned.set(ri.productId.toString(), (alreadyReturned.get(ri.productId.toString()) ?? 0) + ri.quantity)
      }
    }
    const quantityErrors: { path: string; message: string }[] = []
    for (let i = 0; i < items.length; i++) {
      const line = items[i]
      const ordered = orderItems.get(line.productId)
      if (!ordered) {
        quantityErrors.push({
          path: `items.${i}.productId`,
          message: 'This product is not on the order',
        })
        continue
      }
      const returnable = ordered.quantity - (alreadyReturned.get(line.productId.toString()) ?? 0) - line.quantity
      if (returnable < 0) {
        quantityErrors.push({
          path: `items.${i}.quantity`,
          message: `Only ${ordered.quantity - (alreadyReturned.get(line.productId.toString()) ?? 0)} of ${ordered.productName} can still be returned`,
        })
      }
    }
    if (quantityErrors.length > 0) return validationError('Return quantity exceeds what was ordered', quantityErrors)

    const allowNegative = await getAllowNegativeStock(db)
    const postingDate = date ? parseLedgerDate(date) : getKarachiDate()
    const refundAccountId =
      refundAmount > 0 ? await resolvePostingAccount(db, accountId, 'salesIncomeAccountId') : null
    const courierAccountId =
      courierCost && courierCost > 0 ? await resolvePostingAccount(db, accountId, 'purchasingAccountId') : null

    const result = await runInTransaction(async (session) => {
      const col = getReturnCollection(db)
      const returnNumber = await nextReturnNumber(db, session)
      const now = new Date()

      const record: ReturnRecord = {
        orderId: order._id!,
        returnNumber,
        items: items.map((i) => ({
          productId: new ObjectId(i.productId),
          quantity: i.quantity,
          reason: i.reason,
          outcome: i.outcome,
        })),
        outcome,
        refundAmount,
        courierCost: courierCost && courierCost > 0 ? courierCost : undefined,
        location,
        notes: notes || undefined,
        idempotencyKey,
        createdAt: now,
        updatedAt: now,
        createdBy: actor.id,
      }

      const inserted = await insertIdempotent(col, record as never, session)
      if (!inserted.created) {
        return { replayReturn: inserted.doc as unknown as ReturnRecord, record: null as ReturnRecord | null }
      }
      record._id = inserted.doc._id as ObjectId

      // Unit cost basis: the WAC snapshot from the order line when present,
      // otherwise the product's current cost — read in-transaction.
      const productIds = [...new Set(record.items.map((i) => i.productId.toString()))]
      const products = await getProductCollection(db)
        .find({ _id: { $in: productIds.map((p) => new ObjectId(p)) } } as never, { session })
        .toArray()
      const costById = new Map(products.map((p) => [p._id!.toString(), p.cost]))

      const movementIds: ObjectId[] = []
      for (let i = 0; i < record.items.length; i++) {
        const item = record.items[i]
        const itemOutcome = item.outcome ?? (record.outcome as ReturnItemOutcome)
        const ordered = orderItems.get(item.productId.toString())
        const unitCost =
          ordered?.unitCost ?? costById.get(item.productId.toString()) ?? 0

        const { movement } = await postMovement(
          db,
          {
            productId: item.productId,
            movementType: OUTCOME_MOVEMENT[itemOutcome],
            quantity: item.quantity,
            toLocation: location as Location,
            unitCost,
            referenceId: record._id,
            referenceType: 'return',
            idempotencyKey: `return:${record._id!.toString()}:item:${i}`,
            notes: `Return ${returnNumber}: ${item.reason}`,
            date: postingDate,
            createdBy: actor.id,
            allowNegative,
          },
          session
        )
        if (movement._id) movementIds.push(movement._id)
      }

      let refundTransactionId: ObjectId | undefined
      if (refundAmount > 0 && refundAccountId) {
        const ledger = await createLedgerEntry(
          db,
          {
            type: 'expense',
            amount: refundAmount,
            date: (postingDate instanceof Date ? postingDate : now).toISOString(),
            accountId: refundAccountId.toString(),
            category: REFUND_CATEGORY,
            note: `Return ${returnNumber}: refund for order ${order.orderNumber} (${order.customerName})`,
            idempotencyKey: `return:${record._id!.toString()}:refund`,
          },
          actor,
          { session }
        )
        refundTransactionId = ledger.doc._id
      }

      let courierTransactionId: ObjectId | undefined
      if (record.courierCost && courierAccountId) {
        const ledger = await createLedgerEntry(
          db,
          {
            type: 'expense',
            amount: record.courierCost,
            date: (postingDate instanceof Date ? postingDate : now).toISOString(),
            accountId: courierAccountId.toString(),
            category: REFUND_CATEGORY,
            note: `Return ${returnNumber}: return courier cost for order ${order.orderNumber}`,
            idempotencyKey: `return:${record._id!.toString()}:courier`,
          },
          actor,
          { session }
        )
        courierTransactionId = ledger.doc._id
      }

      await col.updateOne(
        { _id: record._id } as never,
        { $set: { movementIds, refundTransactionId, courierTransactionId } } as never,
        { session }
      )
      record.movementIds = movementIds
      record.refundTransactionId = refundTransactionId
      record.courierTransactionId = courierTransactionId

      // Keep the order in sync: fully returned → `returned`; a refund at or
      // above the order total marks the payment refunded.
      const totalOrdered = order.items.reduce((sum, i) => sum + i.quantity, 0)
      const totalReturnedNow =
        [...alreadyReturned.values()].reduce((sum, n) => sum + n, 0) +
        record.items.reduce((sum, i) => sum + i.quantity, 0)
      const orderUpdates: Record<string, unknown> = { updatedAt: now }
      if (totalReturnedNow >= totalOrdered && order.orderStatus !== 'returned') {
        orderUpdates.orderStatus = 'returned'
      }
      if (refundTransactionId) {
        orderUpdates.refundTransactionId = refundTransactionId
        if (refundAmount >= order.total) orderUpdates.paymentStatus = 'refunded'
      }
      if (Object.keys(orderUpdates).length > 1) {
        await getOrderCollection(db).updateOne({ _id: order._id } as never, { $set: orderUpdates } as never, { session })
      }

      return { replayReturn: null as ReturnRecord | null, record }
    })

    if (result.replayReturn) {
      return successResponse({ return: returnToJSON(result.replayReturn), replay: true })
    }

    const created = result.record!
    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: actor.id,
      userEmail: actor.email,
      action: 'return_created',
      entityType: 'return',
      entityId: created._id ?? null,
      newValue: returnToJSON(created),
      details: `Return ${created.returnNumber} for order ${order.orderNumber}: ${created.items
        .map((i) => `${i.quantity} × ${orderItems.get(i.productId.toString())?.productName ?? '?'} (${i.outcome ?? created.outcome})`)
        .join(', ')}${refundAmount > 0 ? `; refund ${formatPaisa(refundAmount)}` : ''}`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })

    const freshOrder = await getOrderCollection(db).findOne({ _id: order._id } as never)
    return successResponse(
      {
        return: returnToJSON(created),
        order: freshOrder ? orderToJSON(freshOrder as Order) : undefined,
        replay: false,
      },
      201
    )
  } catch (error) {
    console.error('POST /api/returns failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const POST = withAuth(__POST)
