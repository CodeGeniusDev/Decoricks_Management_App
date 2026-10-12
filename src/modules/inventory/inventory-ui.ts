import type { MovementType } from '@/lib/stock-math'

/**
 * Client-side types and helpers for the Phase 5 inventory screens.
 *
 * The API serializes dates to ISO strings and never ships ObjectIds, so these
 * interfaces mirror the JSON exactly. Every money figure stays integer paisa
 * until the last display call — the same rule the Phase 3 ledger screens follow.
 *
 * Stock numbers are always the DERIVED pools the movement ledger proves; no
 * screen here receives a typed-in "available" figure.
 */

export interface Pagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

/* --------------------------------- products -------------------------------- */

export interface ProductVariantView {
  name: string
  sku?: string
  sellingPrice?: number
}

export interface ProductView {
  _id: string
  sku: string
  name: string
  description?: string
  category: string
  /** Weighted average cost in paisa; purchases move it, this screen reads it. */
  cost: number
  sellingPrice: number
  reorderLevel?: number | null
  variants?: ProductVariantView[]
  isActive: boolean
  createdAt: string
  updatedAt: string
  /** Added by `GET /api/products` so the list can show stock without a second call. */
  totalQuantity?: number
  stockByLocation?: Record<string, number>
}

/* ---------------------------------- stock ---------------------------------- */

export interface StockPoolView {
  location: string
  available: number
  damaged: number
  returned: number
  /** Available units at this location × weighted average cost, paisa. */
  valuation: number
}

/**
 * The three derived pools for one product at one location, keyed
 * `${productId}|${location}` by the screens that fetch `/api/stock/summary`.
 * A missing entry means the ledger has never touched that pair, i.e. zero.
 */
export interface StockPools {
  available: number
  damaged: number
  returned: number
}

export interface SummaryItemView {
  _id: string
  sku: string
  name: string
  category: string
  isActive: boolean
  cost: number
  sellingPrice: number
  reorderLevel: number | null
  byLocation: StockPoolView[]
  totalAvailable: number
  totalDamaged: number
  totalReturned: number
  valuation: number
  lowStock: boolean
}

export interface StockLocationTotalsView {
  location: string
  available: number
  damaged: number
  returned: number
  valuation: number
}

export interface StockSummaryView {
  items: SummaryItemView[]
  totals: {
    productCount: number
    totalValuation: number
    totalDamaged: number
    totalReturned: number
    lowStockCount: number
    locations: string[]
    byLocation: StockLocationTotalsView[]
  }
}

export interface StockRowView {
  _id: string
  productId: string
  location: string
  quantity: number
  lastUpdated: string
  updatedAt: string
  productName?: string
  damaged?: number
  returned?: number
}

/* -------------------------------- movements -------------------------------- */

export interface MovementView {
  _id: string
  productId: string
  movementType: MovementType
  quantity: number
  fromLocation: string | null
  toLocation: string | null
  unitCost?: number
  direction: string
  referenceId?: string | null
  referenceType?: string | null
  reversesId?: string
  reversedBy?: string
  isReversal: boolean
  status: string
  idempotencyKey?: string
  notes?: string
  date: string
  createdAt: string
  createdBy: string
  productName?: string
}

export interface MovementsView {
  items: MovementView[]
  pagination: Pagination
}

/* -------------------------------- purchases -------------------------------- */

export interface PurchaseView {
  _id: string
  purchaseNumber: string
  supplierId: string | null
  supplierName?: string
  productId: string
  productName: string
  location: string
  quantity: number
  unitCost: number
  totalCost: number
  ledgerTransactionId?: string
  movementId?: string
  date: string
  notes?: string
  createdAt: string
  createdBy: string
}

export interface PurchasesView {
  items: PurchaseView[]
  pagination: Pagination
  totals: { filteredSpendPaisa: number }
}

/* --------------------------------- suppliers --------------------------------- */

/*
 * Suppliers keep their own view type in `/suppliers`; the purchase form only
 * needs `Pick` of it, so nothing is redefined here.
 */

/* ---------------------------- movement pool math ---------------------------- */

/**
 * The pool a movement type writes into, for display only. `sale_out` and
 * `transfer` reduce available; the return outcomes split into the three pools.
 * Mirrors `movementEffects` in `@/lib/stock-math` — the server stays the
 * authority, this only labels what the ledger already says.
 */
export const MOVEMENT_POOL_LABEL: Record<MovementType, string> = {
  purchase_in: 'Available',
  sale_out: 'Available (out)',
  return_restock: 'Available',
  return_damaged: 'Damaged',
  return_writeoff: 'Written off',
  damage: 'Damaged',
  writeoff: 'Written off',
  transfer: 'Moved',
  adjustment: 'Available',
}

export type BadgeVariant = 'default' | 'success' | 'warning' | 'error'

/**
 * Colour by whether a movement ADDS to sellable stock, REMOVES from it, or
 * moves units into a non-sellable pool. Neutral types stay neutral so the
 * list does not read like a profit-and-loss statement.
 */
export const MOVEMENT_BADGE_VARIANT: Record<MovementType, BadgeVariant> = {
  purchase_in: 'success',
  sale_out: 'error',
  return_restock: 'success',
  return_damaged: 'warning',
  return_writeoff: 'warning',
  damage: 'warning',
  writeoff: 'error',
  transfer: 'default',
  adjustment: 'default',
}

/* ---------------------------------- filters --------------------------------- */

/** A date-range pair in `YYYY-MM-DD`, interpreted as Karachi day boundaries. */
export interface DayRange {
  from: string
  to: string
}

/**
 * Appends the shared date filters to a query builder.
 *
 * The values are plain `YYYY-MM-DD` civil dates as typed on the Karachi
 * calendar. Every Phase 5 read route converts them itself with
 * `karachiDateInputRange`, so the client must NOT pre-convert to UTC — doing it
 * twice would shift the window by five hours and drop the first hours of each
 * day.
 */
export const appendRangeParams = (params: URLSearchParams, range: DayRange): void => {
  if (range.from) params.set('from', range.from)
  if (range.to) params.set('to', range.to)
}

/* --------------------------------- sub-nav --------------------------------- */

export interface SubNavItem {
  href: string
  label: string
}

/** SPEC §2.1 nests these under Inventory; the sidebar stays flat. */
export const INVENTORY_SUBNAV: SubNavItem[] = [
  { href: '/inventory', label: 'Overview' },
  { href: '/inventory/products', label: 'Products' },
  { href: '/inventory/movements', label: 'Stock movements' },
  { href: '/inventory/purchases', label: 'Purchases' },
]
