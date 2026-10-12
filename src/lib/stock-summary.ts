import { ObjectId } from 'mongodb'
import type { Db } from 'mongodb'
import { getProductCollection, type Location, type Product } from '@/lib/models/Product'
import { getStockMovementCollection, type StockMovement } from '@/lib/models/Inventory'
import {
  STOCK_LOCATIONS,
  deriveStock,
  valuationLine,
  type DerivedStock,
} from '@/lib/stock-math'

/**
 * Inventory valuation from the movement ledger (SPEC §5.7).
 *
 * One builder, three consumers: the overview screen, the stock CSV export and
 * the valuation/COGS/margin calculation panel. They used to each re-derive the
 * pools in their own way, which is exactly how two screens end up showing
 * different stock for the same product on the same afternoon. Everything here
 * reads `stockMovements` and never the `stock` projection, so the figure shown
 * is the figure the ledger proves.
 *
 *   valuation(product) = total available units × weighted average cost
 *
 * `Product.cost` IS the weighted average cost: purchases restate it and nothing
 * else writes it, so a valuation computed from it cannot disagree with the cost
 * basis COGS was taken from on the last sale.
 */

export interface StockLocationRow extends DerivedStock {
  location: Location
  /** Available units at this location valued at the weighted average cost. */
  valuation: number
}

export interface StockSummaryItem {
  _id: string
  sku: string
  name: string
  category: string
  isActive: boolean
  /** Weighted average cost in paisa. */
  cost: number
  sellingPrice: number
  reorderLevel: number | null
  byLocation: StockLocationRow[]
  totalAvailable: number
  totalDamaged: number
  totalReturned: number
  valuation: number
  lowStock: boolean
}

export interface StockLocationTotals extends DerivedStock {
  location: Location
  valuation: number
}

export interface StockSummary {
  items: StockSummaryItem[]
  totals: {
    productCount: number
    totalValuation: number
    totalDamaged: number
    totalReturned: number
    lowStockCount: number
    locations: Location[]
    byLocation: StockLocationTotals[]
  }
}

export interface StockSummaryOptions {
  /** Archived products are excluded unless asked for explicitly. */
  includeArchived?: boolean
  /** Restrict to one product; used by the calculation panel's drill-down. */
  productId?: string
}

/**
 * A product is low on stock when a reorder level is set and the sellable units
 * across BOTH locations sit at or below it. Reorder level is a purchasing
 * threshold for the whole business, not per warehouse, so it is compared with
 * the combined figure — and only ever against a level the user actually typed.
 */
const isLowStock = (totalAvailable: number, reorderLevel: number | null): boolean =>
  reorderLevel !== null && reorderLevel > 0 && totalAvailable <= reorderLevel

export async function buildStockSummary(
  db: Db,
  options: StockSummaryOptions = {}
): Promise<StockSummary> {
  const { includeArchived = false, productId } = options

  const filter: Record<string, unknown> = includeArchived ? {} : { isActive: true }
  if (productId) {
    if (!/^[0-9a-fA-F]{24}$/.test(productId)) {
      throw new TypeError('productId must be a 24-character hex id')
    }
    filter._id = new ObjectId(productId)
  }

  const [products, movements] = await Promise.all([
    getProductCollection(db).find(filter).toArray(),
    getStockMovementCollection(db).find({}).toArray(),
  ])

  const derived = deriveStock(
    movements.map((m: StockMovement) => ({
      ...m,
      productId: m.productId.toString(),
    })) as never
  )

  let totalValuation = 0
  let totalDamaged = 0
  let totalReturned = 0
  let lowStockCount = 0

  const locationTotals = new Map<Location, StockLocationTotals>(
    STOCK_LOCATIONS.map((location) => [
      location,
      { location, available: 0, damaged: 0, returned: 0, valuation: 0 },
    ])
  )

  const items: StockSummaryItem[] = products.map((p: Product) => {
    const pid = p._id!.toString()

    const byLocation: StockLocationRow[] = STOCK_LOCATIONS.map((location) => {
      const pool = derived.get(`${pid}|${location}`) ?? { available: 0, damaged: 0, returned: 0 }
      const valuation = valuationLine(pool.available, p.cost)
      const totals = locationTotals.get(location)!
      totals.available += pool.available
      totals.damaged += pool.damaged
      totals.returned += pool.returned
      totals.valuation += valuation
      return { location, ...pool, valuation }
    })

    const totalAvailable = byLocation.reduce((sum, row) => sum + row.available, 0)
    const itemDamaged = byLocation.reduce((sum, row) => sum + row.damaged, 0)
    const itemReturned = byLocation.reduce((sum, row) => sum + row.returned, 0)
    const valuation = valuationLine(totalAvailable, p.cost)

    const lowStock = isLowStock(totalAvailable, p.reorderLevel ?? null)
    if (lowStock) lowStockCount += 1
    totalValuation += valuation
    totalDamaged += itemDamaged
    totalReturned += itemReturned

    return {
      _id: pid,
      sku: p.sku,
      name: p.name,
      category: p.category,
      isActive: p.isActive,
      cost: p.cost,
      sellingPrice: p.sellingPrice,
      reorderLevel: p.reorderLevel ?? null,
      byLocation,
      totalAvailable,
      totalDamaged: itemDamaged,
      totalReturned: itemReturned,
      valuation,
      lowStock,
    }
  })

  return {
    items,
    totals: {
      productCount: items.length,
      totalValuation,
      totalDamaged,
      totalReturned,
      lowStockCount,
      locations: STOCK_LOCATIONS,
      byLocation: STOCK_LOCATIONS.map((location) => locationTotals.get(location)!),
    },
  }
}
