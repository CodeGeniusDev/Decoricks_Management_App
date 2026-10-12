import { NextRequest } from 'next/server'
import { ObjectId, type ClientSession, type Db } from 'mongodb'
import { handleRouteError, withAuth, getRequestMeta, HttpError } from '@/lib/http'
import { authorize, authorizeScoped, authorizeStockWrite, SCOPED_SALES_FULL_EDIT } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import {
  getOrderCollection,
  orderToJSON,
  type Order,
  type OrderItem,
} from '@/lib/models/Sales'
import { ensureInventoryIndexes } from '@/lib/models/Inventory'
import { getProductCollection, type Location } from '@/lib/models/Product'
import { orderStatusUpdateSchema, orderEditSchema } from '@/lib/schemas/operations'
import { priceOrderItems } from '@/lib/order-pricing'
import { getKarachiDate } from '@/lib/date'
import { recordAuditEntry } from '@/lib/audit'
import { notFoundError, successResponse, validationError } from '@/lib/api-response'
import { createLedgerEntry, parseLedgerDate, type ActorContext } from '@/lib/finance-ledger'
import { resolvePostingAccount } from '@/lib/ledger-accounts'
import {
  getAllowNegativeStock,
  postMovement,
  reverseMovement,
  runInTransaction,
} from '@/lib/stock-service'
import { formatPaisa } from '@/lib/money'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)
const badId = () => validationError('Invalid order id', [{ path: 'id', message: 'Malformed id' }])

/** Seeded ledger slugs (SPEC Appendix A). */
const INCOME_CATEGORY = 'sales_revenue'
const COURIER_CATEGORY = 'shipping_courier'

/** Fulfilment state machine. `returned` is primarily driven by the Returns API. */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending: ['processing', 'shipped', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered', 'returned', 'cancelled'],
  delivered: ['returned'],
  returned: [],
  cancelled: [],
}

const transitionError = (from: string, to: string) =>
  validationError('Invalid order transition', [
    { path: 'orderStatus', message: `Cannot move an order from "${from}" to "${to}"` },
  ])

/**
 * Reverse every still-open reservation of an order and clear the list, so a
 * cancelled or refused order restores its stock exactly once. Deterministic
 * movement idempotency keys make a replayed attempt a no-op, and clearing
 * `stockMovementIds` in the same transaction guarantees nothing is ever
 * double-credited.
 */
async function restoreReservedStock(
  db: Db,
  order: Order,
  actorId: ObjectId,
  reasonPrefix: string,
  allowNegative: boolean,
  session: ClientSession
): Promise<number> {
  const ids = order.stockMovementIds ?? []
  const orderId = order._id!.toString()
  for (const movementId of ids) {
    await reverseMovement(
      db,
      movementId,
      {
        createdBy: actorId,
        reason: `Order ${order.orderNumber} ${reasonPrefix}`,
        idempotencyKey: `order:${orderId}:${reasonPrefix}:${movementId.toString()}`,
        allowNegative,
      },
      session
    )
  }
  return ids.length
}

/** GET /api/orders/[id] */
async function __GET(_request: NextRequest, context: RouteContext) {
  try {
    await authorize('sales', 'view')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const doc = await getOrderCollection(db).findOne({ _id: new ObjectId(id) } as never)
    if (!doc) return notFoundError('Order not found')

    return successResponse(orderToJSON(doc))
  } catch (error) {
    console.error('GET /api/orders/[id] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * PATCH /api/orders/[id] — the order lifecycle.
 *
 * Every side effect happens in one transaction, keyed by deterministic
 * idempotency keys so a retried request can never double-post:
 *
 *   cancel / refuse  → linked reversal movements restore reserved stock
 *                      (refused: no income was ever posted, so nothing else
 *                      reverses; cancelling a paid order is blocked — refunds
 *                      go through the Returns API instead).
 *   ship (dispatch)  → the courier charge becomes the linked `shipping_courier`
 *                      expense. Courier cost is ours the moment the parcel
 *                      leaves, independent of the COD outcome.
 *   deliver          → delivery date is recorded; confirming `cashReceived`
 *                      posts the single `sales_revenue` income for the order
 *                      total and marks the payment received.
 *
 * STRICT authorization: transitions that write stock pass through
 * `authorizeStockWrite` for the order's ship-from location.
 */
async function __PATCH(request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('sales', 'edit')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const parsed = orderStatusUpdateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }
    const { orderStatus: target, cashReceived, date, accountId, idempotencyKey } = parsed.data
    if (
      !target &&
      !parsed.data.paymentStatus &&
      !parsed.data.codOutcome &&
      cashReceived === undefined
    ) {
      return validationError('Nothing to update', [
        { path: 'orderStatus', message: 'Provide at least one field to change' },
      ])
    }

    const actor: ActorContext = {
      id: auth.user._id as ObjectId,
      name: auth.user.name,
      email: auth.user.email,
    }

    const db = await getDatabase()
    await ensureInventoryIndexes(db)
    const col = getOrderCollection(db)
    const _id = new ObjectId(id)
    const existing = await col.findOne({ _id } as never)
    if (!existing) return notFoundError('Order not found')

    const willCancel = target === 'cancelled' && existing.orderStatus !== 'cancelled'
    const willRefuse =
      parsed.data.codOutcome === 'refused' &&
      existing.codOutcome !== 'refused' &&
      !willCancel
    const restoresStock = willCancel || willRefuse

    if (willRefuse && existing.orderStatus !== 'shipped' && existing.orderStatus !== 'returned') {
      return validationError('Order not dispatched', [
        {
          path: 'codOutcome',
          message: 'A refusal can only be recorded after dispatch. Cancel the order instead.',
        },
      ])
    }

    // A paid order cannot be cancelled or "refused" — the money already went
    // through the ledger; the Returns API is the only correct reversal path.
    if (restoresStock && (existing.incomeTransactionId || existing.codCashReceivedAt)) {
      return validationError('Order cash already received', [
        {
          path: 'orderStatus',
          message: 'This order has recorded income. Use Returns to refund and restock it.',
        },
      ])
    }
    if (cashReceived && !(existing.orderStatus === 'delivered' || target === 'delivered')) {
      return validationError('Cash can only be received for delivered orders', [
        { path: 'cashReceived', message: 'Deliver the order first' },
      ])
    }

    if (target && target !== existing.orderStatus) {
      const allowed = ALLOWED_TRANSITIONS[existing.orderStatus] ?? []
      if (!allowed.includes(target)) {
        return transitionError(existing.orderStatus, target)
      }
    }

    // Stock authorization for restores uses the location the reservation was
    // made at; a missing one (legacy order) has no movements to restore.
    if (restoresStock && (existing.stockMovementIds?.length ?? 0) > 0) {
      await authorizeStockWrite([existing.shipFromLocation ?? 'sheikhupura', existing.shipFromLocation ?? 'lahore'])
    }

    const allowNegative = await getAllowNegativeStock(db)
    const now = getKarachiDate()

    const result = await runInTransaction(async (session) => {
      const fresh = await col.findOne({ _id } as never, { session })
      if (!fresh) throw new HttpError('Order not found', 404, 'NOT_FOUND')
      const updates: Record<string, unknown> = { updatedAt: now }

      let restored = 0
      if ((willCancel || willRefuse) && (fresh.stockMovementIds?.length ?? 0) > 0) {
        restored = await restoreReservedStock(
          db,
          fresh,
          actor.id,
          willCancel ? 'cancelled — stock restored' : 'refused — stock restored',
          allowNegative,
          session
        )
        updates.stockMovementIds = []
      }

      if (target) updates.orderStatus = target
      if (parsed.data.paymentStatus) updates.paymentStatus = parsed.data.paymentStatus
      if (parsed.data.codOutcome) updates.codOutcome = parsed.data.codOutcome
      if (target === 'delivered') {
        updates.deliveryDate = date ? parseLedgerDate(date) : now
      }

      // Dispatch: record the courier expense exactly once.
      const dispatching = target === 'shipped' && !fresh.courierExpenseTransactionId
      if (dispatching && (fresh.courierCharges ?? 0) > 0) {
        const courierAccountId = await resolvePostingAccount(db, accountId, 'purchasingAccountId', session)
        const ledger = await createLedgerEntry(
          db,
          {
            type: 'expense',
            amount: fresh.courierCharges!,
            date: now.toISOString(),
            accountId: courierAccountId.toString(),
            category: COURIER_CATEGORY,
            note: `Order ${fresh.orderNumber}: courier ${fresh.courierName ? `(${fresh.courierName}) ` : ''}charges`,
            idempotencyKey: idempotencyKey ? `${idempotencyKey}:courier` : `order:${fresh._id!.toString()}:courier`,
          },
          actor,
          { session }
        )
        updates.courierExpenseTransactionId = ledger.doc._id
      }

      // Delivered + cash confirmed: the one income posting for the order.
      const willBeDelivered = target === 'delivered' || fresh.orderStatus === 'delivered'
      const confirmCash = cashReceived === true && !fresh.incomeTransactionId && !fresh.codCashReceivedAt
      if (confirmCash) {
        if (!willBeDelivered) {
          throw new HttpError('Cash receipt requires a delivered order', 400, 'VALIDATION_ERROR', [
            { path: 'cashReceived', message: 'Deliver the order first' },
          ])
        }
        const incomeAccountId = await resolvePostingAccount(db, accountId, 'salesIncomeAccountId', session)
        const ledger = await createLedgerEntry(
          db,
          {
            type: 'income',
            amount: fresh.total,
            date: (date ? parseLedgerDate(date) : fresh.deliveryDate ?? now).toISOString(),
            accountId: incomeAccountId.toString(),
            category: INCOME_CATEGORY,
            paymentMethod: fresh.paymentMethod,
            note: `Order ${fresh.orderNumber}: ${fresh.customerName} (${fresh.salesChannel}) — ${formatPaisa(fresh.total)}`,
            idempotencyKey: idempotencyKey ? `${idempotencyKey}:income` : `order:${fresh._id!.toString()}:income`,
          },
          actor,
          { session }
        )
        updates.incomeTransactionId = ledger.doc._id
        updates.codCashReceivedAt = now
        updates.paymentStatus = 'received'
      }

      const keys = Object.keys(updates).filter((k) => k !== 'updatedAt')
      if (keys.length > 0) {
        await col.updateOne({ _id } as never, { $set: updates } as never, { session })
      }
      const updated = await col.findOne({ _id } as never, { session })
      return { updated, restored, changed: keys.length > 0 }
    })

    if (result.changed) {
      const meta = await getRequestMeta()
      await recordAuditEntry(db, {
        userId: actor.id,
        userEmail: actor.email,
        action: 'order_status_changed',
        entityType: 'order',
        entityId: _id,
        oldValue: {
          orderStatus: existing.orderStatus,
          paymentStatus: existing.paymentStatus,
          codOutcome: existing.codOutcome,
        },
        newValue: orderToJSON(result.updated!),
        details:
          `Order ${existing.orderNumber} updated` +
          (result.restored > 0 ? `; ${result.restored} reservation(s) restored` : ''),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })
    }
    return successResponse(orderToJSON(result.updated!))
  } catch (error) {
    console.error('PATCH /api/orders/[id] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * PUT /api/orders/[id] — edit before dispatch.
 *
 * Contents, customer details and pricing remain editable only until the
 * parcel ships. When the line items or the ship-from location change, the old
 * reservations are reversed and new ones posted in the same transaction —
 * still append-only corrections, never an edit of a movement. A
 * `reserveGeneration` counter keeps every attempt's movement idempotency keys
 * unique while replaying the same edit stays a no-op.
 */
async function __PUT(request: NextRequest, context: RouteContext) {
  try {
    // SPEC §4.2 Sales Edit for Hasnat covers delivery outcomes/returns only,
    // not order contents or pricing — PUT needs the `sales.full_edit` grant,
    // which is Founder-only by default.
    const auth = await authorizeScoped('sales', 'edit', SCOPED_SALES_FULL_EDIT)

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const parsed = orderEditSchema.safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const db = await getDatabase()
    await ensureInventoryIndexes(db)
    const col = getOrderCollection(db)
    const _id = new ObjectId(id)

    const existing = await col.findOne({ _id } as never)
    if (!existing) return notFoundError('Order not found')

    if (existing.orderStatus !== 'pending' && existing.orderStatus !== 'processing') {
      return validationError('Order can no longer be edited', [
        {
          path: 'orderStatus',
          message: `Only orders before dispatch can be edited (this one is "${existing.orderStatus}")`,
        },
      ])
    }

    const updates: Record<string, unknown> = {}
    for (const field of [
      'customerName',
      'customerPhone',
      'customerCity',
      'customerAddress',
      'notes',
      'salesChannel',
      'courierCharges',
      'courierName',
    ] as const) {
      if (parsed.data[field] !== undefined) updates[field] = parsed.data[field]
    }
    if (parsed.data.shippingCost !== undefined) updates.shippingCost = parsed.data.shippingCost

    const nextItemsSubmitted = parsed.data.items
    const nextLocation = parsed.data.shipFromLocation
    const itemsChanged = nextItemsSubmitted !== undefined
    const locationChanged = nextLocation !== undefined && nextLocation !== existing.shipFromLocation
    const mustReReserve = itemsChanged || locationChanged

    const actor: ActorContext = {
      id: auth.user._id as ObjectId,
      name: auth.user.name,
      email: auth.user.email,
    }

    let pricedItems: OrderItem[] | null = null
    if (itemsChanged) {
      const priced = await priceOrderItems(nextItemsSubmitted!, db)
      if (!priced.ok) return priced.response
      pricedItems = priced.items
    }

    if (mustReReserve) {
      // Stock is written at the old location (restore) and the new one
      // (reserve) — under STRICT rules both must be authorized.
      const locations = new Set<Location>()
      if (existing.shipFromLocation) locations.add(existing.shipFromLocation)
      if (nextLocation) locations.add(nextLocation)
      await authorizeStockWrite([...locations])
    }

    const allowNegative = await getAllowNegativeStock(db)
    const now = getKarachiDate()

    const updated = await runInTransaction(async (session) => {
      const fresh = await col.findOne({ _id } as never, { session })
      if (!fresh) return null

      if (mustReReserve) {
        const gen = (fresh.reserveGeneration ?? 0) + 1
        await restoreReservedStock(db, fresh, actor.id, `re-reserved (edit #${gen})`, allowNegative, session)

        const items = pricedItems ?? fresh.items
        const location = nextLocation ?? fresh.shipFromLocation
        if (!location) throw new Error('Order has no ship-from location')

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
              fromLocation: location,
              unitCost: item.unitCost,
              referenceId: _id,
              referenceType: 'order',
              idempotencyKey: `order:${_id.toString()}:out:g${gen}:${i}`,
              notes: `Order ${fresh.orderNumber} (edit #${gen})`,
              date: now,
              createdBy: actor.id,
              allowNegative,
            },
            session
          )
          if (movement._id) movementIds.push(movement._id)
        }

        updates.items = lineItems
        updates.stockMovementIds = movementIds
        updates.reserveGeneration = gen
        if (nextLocation) updates.shipFromLocation = nextLocation
      }

      const nextItems = (updates.items ?? fresh.items) as OrderItem[]
      const subtotal = nextItems.reduce((sum, i) => sum + i.total, 0)
      const shippingCost = (updates.shippingCost ?? fresh.shippingCost) as number
      updates.subtotal = subtotal
      updates.total = subtotal + shippingCost
      updates.updatedAt = now

      await col.updateOne({ _id } as never, { $set: updates } as never, { session })
      return col.findOne({ _id } as never, { session })
    })

    if (!updated) return notFoundError('Order not found')

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: actor.id,
      userEmail: actor.email,
      action: 'order_updated',
      entityType: 'order',
      entityId: _id,
      oldValue: orderToJSON(existing),
      newValue: orderToJSON(updated),
      details: `Order ${existing.orderNumber} edited${mustReReserve ? ' (stock re-reserved)' : ''}`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    return successResponse(orderToJSON(updated))
  } catch (error) {
    console.error('PUT /api/orders/[id] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * DELETE /api/orders/[id]
 *
 * Only cancelled orders may be removed, so genuine order history cannot be
 * deleted by accident. A cancelled order has already restored its stock, so
 * deleting it touches neither inventory nor the ledger.
 */
async function __DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const auth = await authorize('sales', 'delete')

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const db = await getDatabase()
    const col = getOrderCollection(db)
    const _id = new ObjectId(id)

    const existing = await col.findOne({ _id } as never)
    if (!existing) return notFoundError('Order not found')

    if (existing.orderStatus !== 'cancelled') {
      return validationError('Order is not cancelled', [
        {
          path: 'orderStatus',
          message: `Set the order status to "cancelled" before deleting it (currently "${existing.orderStatus}")`,
        },
      ])
    }

    await col.deleteOne({ _id } as never)

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'order_deleted',
      entityType: 'order',
      entityId: _id,
      oldValue: orderToJSON(existing),
      details: `Cancelled order ${existing.orderNumber} deleted`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    return successResponse({ _id: id })
  } catch (error) {
    console.error('DELETE /api/orders/[id] failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
export const PATCH = withAuth(__PATCH)
export const PUT = withAuth(__PUT)
export const DELETE = withAuth(__DELETE)
