import type { BadgeVariant, Pagination } from '@/modules/inventory/inventory-ui'

/**
 * Client-side types and helpers for the Phase 5 sales screens.
 *
 * Mirrors `orderToJSON` / `returnToJSON` after JSON serialization: ids are
 * strings, dates are ISO instants, money is integer paisa until the last
 * display call.
 *
 * Nothing here invents data: product names and unit prices arrive on the order
 * because the server resolved them from the products collection
 * (`src/lib/order-pricing.ts`), never because the browser sent them.
 */

export interface OrderItemView {
  productId: string
  productName: string
  quantity: number
  /** Paisa — the price stored on the product when the order was created. */
  unitPrice: number
  total: number
  /** Weighted average cost snapshot at reservation time; COGS is derived from it. */
  unitCost?: number
}

export interface OrderView {
  _id: string
  orderNumber: string
  customerName: string
  customerPhone: string
  customerCity: string
  customerAddress: string
  items: OrderItemView[]
  subtotal: number
  shippingCost: number
  total: number
  paymentMethod: string
  paymentStatus: string
  orderStatus: string
  codOutcome: string
  courierCharges?: number
  courierName?: string
  salesChannel: string
  deliveryDate?: string
  notes?: string
  shipFromLocation?: string
  stockMovementIds?: string[]
  codCashReceivedAt?: string
  incomeTransactionId?: string
  courierExpenseTransactionId?: string
  refundTransactionId?: string
  createdAt: string
  updatedAt: string
  createdBy: string
}

export interface OrdersView {
  orders: OrderView[]
  pagination: Pagination
}

export interface ReturnItemView {
  productId: string
  quantity: number
  reason: string
  outcome?: ReturnOutcome
}

export type ReturnOutcome = 'restock' | 'damaged' | 'writeoff'

export interface ReturnView {
  _id: string
  orderId: string
  returnNumber: string
  items: ReturnItemView[]
  outcome: ReturnOutcome
  refundAmount: number
  courierCost?: number
  location?: string
  notes?: string
  movementIds?: string[]
  refundTransactionId?: string
  courierTransactionId?: string
  createdAt: string
  updatedAt: string
  createdBy: string
  /** Joined by the list route so the screen can show the order reference. */
  orderNumber?: string
}

export interface ReturnsView {
  items: ReturnView[]
  pagination: Pagination
}

/* --------------------------------- statuses -------------------------------- */

export const ORDER_STATUSES = [
  'pending',
  'processing',
  'shipped',
  'delivered',
  'returned',
  'cancelled',
] as const

export type OrderStatus = (typeof ORDER_STATUSES)[number]

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  processing: 'Processing',
  shipped: 'Shipped',
  delivered: 'Delivered',
  returned: 'Returned',
  cancelled: 'Cancelled',
}

export const ORDER_STATUS_BADGE: Record<string, BadgeVariant> = {
  pending: 'default',
  processing: 'default',
  shipped: 'warning',
  delivered: 'success',
  returned: 'warning',
  cancelled: 'error',
}

export const PAYMENT_STATUSES = ['pending', 'received', 'refunded'] as const
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: 'Payment pending',
  received: 'Cash received',
  refunded: 'Refunded',
}

export const COD_OUTCOME_LABELS: Record<string, string> = {
  pending: 'COD pending',
  delivered: 'Delivered',
  returned: 'Returned',
  refused: 'Refused',
}

/**
 * Lifecycle map for the buttons this screen offers.
 *
 * It is a copy of `ALLOWED_TRANSITIONS` in `/api/orders/[id]`, used only to
 * decide which buttons to show. The server re-checks every transition and
 * answers 400 on an illegal one, so a stale client can never move an order
 * somewhere the state machine does not allow.
 */
export const ORDER_TRANSITIONS: Record<string, OrderStatus[]> = {
  pending: ['processing', 'shipped', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered', 'returned', 'cancelled'],
  delivered: ['returned'],
  returned: [],
  cancelled: [],
}

/** A refusal is only meaningful once the parcel has actually left. */
export const canRecordRefusal = (order: OrderView): boolean =>
  (order.orderStatus === 'shipped' || order.orderStatus === 'returned') &&
  order.codOutcome !== 'refused'

/**
 * Cash confirmation is the single trigger for posting income, so it is offered
 * only on a delivered order that has no income entry yet.
 */
export const canConfirmCash = (order: OrderView): boolean =>
  order.orderStatus === 'delivered' && !order.incomeTransactionId && !order.codCashReceivedAt

/**
 * Cancelling or refusing restores the reserved units. Once income exists the
 * only correct path is a return — cancelling there would leave money in the
 * ledger with no contra entry.
 */
export const canRestoreStock = (order: OrderView): boolean =>
  !order.incomeTransactionId &&
  !order.codCashReceivedAt &&
  (order.stockMovementIds?.length ?? 0) > 0

/** Contents are editable before dispatch, and only with the full-edit grant. */
export const isEditable = (order: OrderView): boolean =>
  order.orderStatus === 'pending' || order.orderStatus === 'processing'

/** A cancelled order is the only one the API lets a client remove. */
export const isDeletable = (order: OrderView): boolean => order.orderStatus === 'cancelled'

/**
 * A return can be raised once the customer had the parcel: delivered, or
 * already returned (a second return for the remaining units).
 */
export const isReturnable = (order: OrderView): boolean =>
  order.orderStatus === 'delivered' || order.orderStatus === 'returned'

/* ---------------------------------- returns --------------------------------- */

export const RETURN_OUTCOME_LABELS: Record<ReturnOutcome, string> = {
  restock: 'Restocked as available',
  damaged: 'Kept as damaged',
  writeoff: 'Written off',
}

export const RETURN_OUTCOME_BADGE: Record<ReturnOutcome, BadgeVariant> = {
  restock: 'success',
  damaged: 'warning',
  writeoff: 'error',
}

/**
 * Which outcomes the picker offers. Damaging and writing off returned goods is
 * a Founder decision (SPEC §5.5), so Partners see restock only — the API
 * refuses the others either way.
 */
export const returnOutcomes = (isFounder: boolean): ReturnOutcome[] =>
  isFounder ? ['restock', 'damaged', 'writeoff'] : ['restock']

/* ---------------------------------- filters --------------------------------- */

export const SALES_SUBNAV = [
  { href: '/sales', label: 'Orders' },
  { href: '/sales/returns', label: 'Returns' },
]

/** Payment method picker. COD is the only live channel today; the field stays configurable. */
export const PAYMENT_METHOD_OPTIONS = [{ value: 'cod', label: 'Cash on delivery' }]
