import { Db, Collection, ObjectId } from 'mongodb'
import type { Location } from '@/lib/models/Product'

export interface OrderItem {
  productId: ObjectId
  productName: string
  quantity: number
  unitPrice: number // paisa
  total: number // paisa
  /** WAC snapshot at reservation time; written to the sale_out movement too. */
  unitCost?: number // paisa
}

export interface Order {
  _id?: ObjectId
  orderNumber: string
  customerName: string
  customerPhone: string
  customerCity: string
  customerAddress: string
  items: OrderItem[]
  subtotal: number // paisa
  shippingCost: number // paisa, default 0
  total: number // paisa
  paymentMethod: string // 'cod'
  paymentStatus: string // 'pending', 'received', 'refunded'
  orderStatus: string // 'pending', 'processing', 'shipped', 'delivered', 'returned', 'cancelled'
  codOutcome: string // 'pending', 'delivered', 'returned', 'refused'
  courierCharges?: number
  courierName?: string
  salesChannel: string
  deliveryDate?: Date
  notes?: string
  /** Location the units ship from; every stock write is authorized for it. */
  shipFromLocation?: Location
  /** Unique sparse index: a replayed create returns the original order. */
  idempotencyKey?: string
  /**
   * sale_out movements written when stock was reserved (deducted) for this
   * order. Non-empty exactly when a cancel must post restorals, so nothing
   * is ever double-credited.
   */
  stockMovementIds?: ObjectId[]
  /**
   * Reservation generation, bumped every time a pre-dispatch edit un-reserves
   * and re-reserves stock. Keeps movement idempotency keys unique per attempt
   * so an edit can never collide with a previous reservation.
   */
  reserveGeneration?: number
  /** When COD cash was confirmed received (drives the one income posting). */
  codCashReceivedAt?: Date
  incomeTransactionId?: ObjectId
  courierExpenseTransactionId?: ObjectId
  refundTransactionId?: ObjectId
  createdAt: Date
  updatedAt: Date
  createdBy: ObjectId
}

export type ReturnItemOutcome = 'restock' | 'damaged' | 'writeoff'

export interface ReturnItem {
  productId: ObjectId
  quantity: number
  reason: string
  /** Per-item override; falls back to the record-level outcome. */
  outcome?: ReturnItemOutcome
}

export interface ReturnRecord {
  _id?: ObjectId
  orderId: ObjectId
  returnNumber: string
  items: ReturnItem[]
  /** Default outcome for items without a per-item override. */
  outcome: string // 'restock', 'damaged', 'writeoff'
  refundAmount: number // paisa
  courierCost?: number
  /** Location the physical units came back to (the order's ship-from). */
  location?: Location
  notes?: string
  idempotencyKey?: string
  movementIds?: ObjectId[]
  refundTransactionId?: ObjectId
  courierTransactionId?: ObjectId
  createdAt: Date
  updatedAt: Date
  createdBy: ObjectId
}

export const getOrderCollection = (db: Db): Collection<Order> => {
  return db.collection<Order>('orders')
}

export const getReturnCollection = (db: Db): Collection<ReturnRecord> => {
  return db.collection<ReturnRecord>('returns')
}

/**
 * Guarantees the uniqueness constraints the order write path relies on.
 * Memoized so it runs once per process; index-creation failures are logged
 * rather than thrown so a permissions-restricted deployment still serves reads.
 */
let ordersIndexesPromise: Promise<void> | null = null

export function ensureOrdersIndexes(db: Db): Promise<void> {
  if (!ordersIndexesPromise) {
    ordersIndexesPromise = (async () => {
      try {
        await Promise.all([
          getOrderCollection(db).createIndex({ orderNumber: 1 }, { unique: true }),
          getOrderCollection(db).createIndex({ createdAt: -1 }),
          getOrderCollection(db).createIndex({ orderStatus: 1, createdAt: -1 }),
          getOrderCollection(db).createIndex({ paymentStatus: 1 }),
          getOrderCollection(db).createIndex({ customerPhone: 1 }),
          getOrderCollection(db).createIndex({ salesChannel: 1, createdAt: -1 }),
          getOrderCollection(db).createIndex(
            { idempotencyKey: 1 },
            { unique: true, sparse: true, name: 'orders_idempotency_unique' }
          ),
          getReturnCollection(db).createIndex({ returnNumber: 1 }, { unique: true }),
          getReturnCollection(db).createIndex({ orderId: 1 }),
          getReturnCollection(db).createIndex({ createdAt: -1 }),
          getReturnCollection(db).createIndex(
            { idempotencyKey: 1 },
            { unique: true, sparse: true, name: 'returns_idempotency_unique' }
          ),
        ])
      } catch (error) {
        console.error('ensureOrdersIndexes failed:', error)
      }
    })()
  }
  return ordersIndexesPromise
}

export const orderToJSON = (order: Order) => ({
  _id: order._id?.toString(),
  orderNumber: order.orderNumber,
  customerName: order.customerName,
  customerPhone: order.customerPhone,
  customerCity: order.customerCity,
  customerAddress: order.customerAddress,
  items: order.items.map((item) => ({
    ...item,
    productId: item.productId.toString(),
    unitPrice: item.unitPrice,
    total: item.total,
  })),
  subtotal: order.subtotal,
  shippingCost: order.shippingCost,
  total: order.total,
  paymentMethod: order.paymentMethod,
  paymentStatus: order.paymentStatus,
  orderStatus: order.orderStatus,
  codOutcome: order.codOutcome,
  courierCharges: order.courierCharges,
  courierName: order.courierName,
  salesChannel: order.salesChannel,
  deliveryDate: order.deliveryDate,
  notes: order.notes,
  shipFromLocation: order.shipFromLocation,
  stockMovementIds: order.stockMovementIds?.map((id) => id.toString()),
  codCashReceivedAt: order.codCashReceivedAt,
  incomeTransactionId: order.incomeTransactionId?.toString(),
  courierExpenseTransactionId: order.courierExpenseTransactionId?.toString(),
  refundTransactionId: order.refundTransactionId?.toString(),
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
  createdBy: order.createdBy.toString(),
})

export const returnToJSON = (r: ReturnRecord) => ({
  _id: r._id?.toString(),
  orderId: r.orderId.toString(),
  returnNumber: r.returnNumber,
  items: r.items.map((item) => ({
    productId: item.productId.toString(),
    quantity: item.quantity,
    reason: item.reason,
    outcome: item.outcome,
  })),
  outcome: r.outcome,
  refundAmount: r.refundAmount,
  courierCost: r.courierCost,
  location: r.location,
  notes: r.notes,
  movementIds: r.movementIds?.map((id) => id.toString()),
  refundTransactionId: r.refundTransactionId?.toString(),
  courierTransactionId: r.courierTransactionId?.toString(),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  createdBy: r.createdBy.toString(),
})