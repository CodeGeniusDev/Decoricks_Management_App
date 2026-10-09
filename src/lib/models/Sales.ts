import { Db, Collection, ObjectId } from 'mongodb'

export interface OrderItem {
  productId: ObjectId
  productName: string
  quantity: number
  unitPrice: number // paisa
  total: number // paisa
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
  createdAt: Date
  updatedAt: Date
  createdBy: ObjectId
}

export interface ReturnItem {
  productId: ObjectId
  quantity: number
  reason: string
}

export interface ReturnRecord {
  _id?: ObjectId
  orderId: ObjectId
  returnNumber: string
  items: ReturnItem[]
  outcome: string // 'restock', 'damaged', 'writeoff'
  refundAmount: number // paisa
  courierCost?: number
  notes?: string
  createdAt: Date
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
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
  createdBy: order.createdBy.toString(),
})