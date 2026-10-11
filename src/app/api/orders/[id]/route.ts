import { handleRouteError, withAuth, getRequestMeta } from '@/lib/http'
import { authorize, authorizeScoped, SCOPED_SALES_FULL_EDIT } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase } from '@/lib/mongodb'
import { getOrderCollection, orderToJSON, type Order } from '@/lib/models/Sales'
import { orderStatusUpdateSchema, orderSchema } from '@/lib/schemas/operations'
import { priceOrderItems } from '@/lib/order-pricing'
import { getKarachiDate } from '@/lib/date'
import { recordAuditEntry } from '@/lib/audit'
import { errorResponse, notFoundError, successResponse, validationError } from '@/lib/api-response'

type RouteContext = { params: Promise<{ id: string }> }

const isObjectId = (v: string) => /^[0-9a-fA-F]{24}$/.test(v)
const badId = () => validationError('Invalid order id', [{ path: 'id', message: 'Malformed id' }])

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

/** PATCH /api/orders/[id] — updates fulfilment/payment status only. */
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
    if (!Object.values(parsed.data).some((v) => v !== undefined)) {
      return validationError('Nothing to update', [
        { path: 'orderStatus', message: 'Provide at least one field to change' },
      ])
    }

    const db = await getDatabase()
    const col = getOrderCollection(db)
    const _id = new ObjectId(id)
    const existing = await col.findOne({ _id } as never)
    if (!existing) return notFoundError('Order not found')

    // A cancelled order is terminal: it cannot be silently re-opened.
    if (existing.orderStatus === 'cancelled' && parsed.data.orderStatus && parsed.data.orderStatus !== 'cancelled') {
      return validationError('Order is cancelled', [
        { path: 'orderStatus', message: 'A cancelled order cannot be re-opened' },
      ])
    }

    const updates: Record<string, unknown> = {}
    if (parsed.data.orderStatus) updates.orderStatus = parsed.data.orderStatus
    if (parsed.data.paymentStatus) updates.paymentStatus = parsed.data.paymentStatus
    if (parsed.data.codOutcome) updates.codOutcome = parsed.data.codOutcome
    if (parsed.data.orderStatus === 'delivered') updates.deliveryDate = getKarachiDate()

    await col.updateOne({ _id } as never, { $set: { ...updates, updatedAt: getKarachiDate() } } as never)
    const updated = await col.findOne({ _id } as never)

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'order_status_changed',
      entityType: 'order',
      entityId: _id,
      oldValue: {
        orderStatus: existing.orderStatus,
        paymentStatus: existing.paymentStatus,
        codOutcome: existing.codOutcome,
      },
      newValue: { ...updates },
      details: `Order ${existing.orderNumber} updated`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    return successResponse(orderToJSON(updated!))
  } catch (error) {
    console.error('PATCH /api/orders/[id] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * PUT /api/orders/[id]
 *
 * Only editable while the order is still `pending`. Once an order has been
 * processed or shipped its contents are part of the fulfilment/returns trail,
 * so they can no longer be rewritten. Monetary totals are recomputed here.
 */
async function __PUT(request: NextRequest, context: RouteContext) {
  try {
    // SPEC §4.2 Sales Edit for Hasnat covers delivery outcomes/returns only,
    // not order contents, customer details or pricing — so PUT (full rewrite)
    // needs the separate `sales.full_edit` grant, which is Founder-only by
    // default. Hasnat uses PATCH below for delivery outcomes and returns.
    const auth = await authorizeScoped('sales', 'edit', SCOPED_SALES_FULL_EDIT)

    const { id } = await context.params
    if (!isObjectId(id)) return badId()

    const parsed = orderSchema.partial().safeParse(await request.json())
    if (!parsed.success) {
      return validationError(
        'Validation failed',
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
      )
    }

    const db = await getDatabase()
    const col = getOrderCollection(db)
    const _id = new ObjectId(id)

    const existing = await col.findOne({ _id } as never)
    if (!existing) return notFoundError('Order not found')

    if (existing.orderStatus !== 'pending') {
      return validationError('Order can no longer be edited', [
        {
          path: 'orderStatus',
          message: `Only pending orders can be edited (this one is "${existing.orderStatus}")`,
        },
      ])
    }

    const updates: Record<string, unknown> = {}

    for (const field of ['customerName', 'customerPhone', 'customerCity', 'customerAddress', 'notes', 'salesChannel'] as const) {
      if (parsed.data[field] !== undefined) updates[field] = parsed.data[field]
    }
    if (parsed.data.shippingCost !== undefined) updates.shippingCost = parsed.data.shippingCost

    if (parsed.data.items !== undefined) {
      // Re-price against the products collection; the client cannot set the
      // stored name, price or line total.
      const priced = await priceOrderItems(parsed.data.items, db)
      if (!priced.ok) return priced.response
      updates.items = priced.items
    }

    // Keep the cached totals consistent with whatever changed.
    const nextItems = (updates.items ?? existing.items) as Order['items']
    const subtotal = nextItems.reduce((sum, i) => sum + i.total, 0)
    const shippingCost = (updates.shippingCost ?? existing.shippingCost) as number
    updates.subtotal = subtotal
    updates.total = subtotal + shippingCost

    await col.updateOne({ _id } as never, { $set: { ...updates, updatedAt: getKarachiDate() } } as never)
    const updated = await col.findOne({ _id } as never)

    const meta = await getRequestMeta()
    await recordAuditEntry(db, {
      userId: auth.user._id as ObjectId,
      userEmail: auth.user.email,
      action: 'order_updated',
      entityType: 'order',
      entityId: _id,
      oldValue: orderToJSON(existing),
      newValue: updated ? orderToJSON(updated) : undefined,
      details: `Order ${existing.orderNumber} edited`,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    })
    return successResponse(orderToJSON(updated!))
  } catch (error) {
    console.error('PUT /api/orders/[id] failed:', error)
    return handleRouteError(error)
  }
}

/**
 * DELETE /api/orders/[id]
 *
 * Only cancelled orders may be removed, so genuine order history cannot be
 * deleted by accident.
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
