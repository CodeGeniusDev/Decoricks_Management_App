import type { Location } from '@/lib/models/Product'

/**
 * Inventory mathematics (Phase 5, SPEC §3.1.5 + §5.3 + §5.7).
 *
 * Stock is never typed: every on-hand figure is DERIVED from the append-only
 * movement ledger. This module is pure (no database, no dates) so the SPEC's
 * worked examples can be asserted directly in unit tests, and so the write
 * path (`stock-service.ts`) and the read path (valuation, COGS, dashboards)
 * cannot drift apart.
 *
 * Movement semantics:
 *   - `quantity` is always a positive integer; the effect below fixes the sign.
 *   - A reversal (`isReversal`) negates every effect of its type, so an
 *     original and its linked reversal cancel out in every derived figure —
 *     the same trick the Phase 3 ledger uses for money.
 *   - `available`, `damaged` and `returned` are the three derived pools. They
 *     are never stored as truth; `stock` rows are a materialized projection of
 *     `available` only (fast guards against overselling), recomputed on demand.
 */

export const MOVEMENT_TYPES = [
  'purchase_in',
  'sale_out',
  'return_restock',
  'return_damaged',
  'return_writeoff',
  'damage',
  'writeoff',
  'transfer',
  'adjustment',
] as const

export type MovementType = (typeof MOVEMENT_TYPES)[number]

export const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  purchase_in: 'Purchase in',
  sale_out: 'Sale out',
  return_restock: 'Return restocked',
  return_damaged: 'Return damaged',
  return_writeoff: 'Return written off',
  damage: 'Damage',
  writeoff: 'Write-off',
  transfer: 'Transfer',
  adjustment: 'Adjustment',
}

export const isMovementType = (value: string): value is MovementType =>
  (MOVEMENT_TYPES as readonly string[]).includes(value)

/** The minimal shape the derivation needs from a stored movement. */
export interface MovementLike {
  movementType: MovementType
  productId: string
  quantity: number
  fromLocation?: string | null
  toLocation?: string | null
  /** Only meaningful for `adjustment`: +1 or -1. */
  direction?: 'in' | 'out'
  /** Paisa snapshot at the time of the movement; drives COGS on sale_out. */
  unitCost?: number
  /** True on the linked correction movement; negates every effect. */
  isReversal?: boolean
  date?: Date | string
}

/** Signed change to one pool at one location. */
export interface PoolDelta {
  location: string
  available: number
  damaged: number
  returned: number
}

/**
 * The one effect table. Every derived stock number in the app comes from this
 * function, so "what a movement does" is defined in exactly one place.
 */
export function movementEffects(m: MovementLike): PoolDelta[] {
  const sign = m.isReversal ? -1 : 1
  const q = m.quantity * sign
  if (q === 0) return []

  switch (m.movementType) {
    case 'purchase_in':
      return [{ location: req(m.toLocation), available: q, damaged: 0, returned: 0 }]
    case 'sale_out':
      return [{ location: req(m.fromLocation), available: -q, damaged: 0, returned: 0 }]
    case 'return_restock':
      return [{ location: req(m.toLocation), available: q, damaged: 0, returned: q }]
    case 'return_damaged':
      // The unit never re-enters available stock; it joins the damaged pool.
      return [{ location: req(m.toLocation), available: 0, damaged: q, returned: q }]
    case 'return_writeoff':
      // Gone: counted as returned, but affects no physical pool.
      return [{ location: req(m.toLocation), available: 0, damaged: 0, returned: q }]
    case 'damage':
      // Found broken in the warehouse: leaves available, joins damaged.
      return [{ location: req(m.fromLocation ?? m.toLocation), available: -q, damaged: q, returned: 0 }]
    case 'writeoff':
      return [{ location: req(m.fromLocation ?? m.toLocation), available: -q, damaged: 0, returned: 0 }]
    case 'transfer':
      return [
        { location: req(m.fromLocation), available: -q, damaged: 0, returned: 0 },
        { location: req(m.toLocation), available: q, damaged: 0, returned: 0 },
      ]
    case 'adjustment': {
      const delta = m.direction === 'out' ? -q : q
      return [{ location: req(m.fromLocation ?? m.toLocation), available: delta, damaged: 0, returned: 0 }]
    }
  }
}

const req = (location?: string | null): string => {
  if (!location) throw new Error('Movement is missing a location for its type')
  return location
}

/** Per product+location derived pools from a full movement history. */
export interface DerivedStock {
  available: number
  damaged: number
  returned: number
}

export function deriveStock(movements: MovementLike[]): Map<string, DerivedStock> {
  const map = new Map<string, DerivedStock>()
  const key = (productId: string, location: string) => `${productId}|${location}`

  for (const m of movements) {
    for (const effect of movementEffects(m)) {
      const k = key(m.productId, effect.location)
      const row = map.get(k) ?? { available: 0, damaged: 0, returned: 0 }
      row.available += effect.available
      row.damaged += effect.damaged
      row.returned += effect.returned
      map.set(k, row)
    }
  }
  return map
}

/** Available units of a product at one location (0 when never moved). */
export function availableAt(derived: Map<string, DerivedStock>, productId: string, location: string): number {
  return derived.get(`${productId}|${location}`)?.available ?? 0
}

/**
 * Weighted average cost after receiving `inQty` at `inCost` on top of
 * `stockQty` already held at `avgCost` (all integer paisa).
 *
 * SPEC §5.3 example: 10 @ 50,000 paisa + 5 @ 60,000 → 53,333 paisa
 * (8,000.00 PKR / 15 = 533.333… PKR, rounded to the paisa).
 */
export function weightedAverageCost(
  stockQty: number,
  avgCost: number,
  inQty: number,
  inCost: number
): number {
  const totalQty = stockQty + inQty
  if (totalQty <= 0) return inCost
  return Math.round((stockQty * avgCost + inQty * inCost) / totalQty)
}

/** COGS for one sale line at the snapshot unit cost (SPEC §5.3). */
export function cogsLine(quantity: number, unitCost: number): number {
  return quantity * unitCost
}

/**
 * Period COGS from sale movements: Σ qty × unitCost on `sale_out`, minus the
 * same on `return_restock` (a restocked unit was never really sold — its cost
 * basis goes back onto the balance sheet with the unit). Damaged and written-
 * off returns keep their COGS: the cost was genuinely incurred. Reversals
 * cancel their originals. Purchases and adjustments never touch COGS.
 */
export function cogsFromMovements(movements: MovementLike[]): number {
  return movements.reduce((sum, m) => {
    if (m.movementType !== 'sale_out' && m.movementType !== 'return_restock') return sum
    const unitCost = m.unitCost ?? 0
    const direction = m.movementType === 'sale_out' ? 1 : -1
    return sum + (m.isReversal ? -1 : 1) * direction * m.quantity * unitCost
  }, 0)
}

/** Inventory valuation line: available units × weighted average cost. */
export function valuationLine(availableQty: number, avgCost: number): number {
  return availableQty * avgCost
}

/** Locations the app ships to and stores at (SPEC Appendix A). */
export const STOCK_LOCATIONS: Location[] = ['sheikhupura', 'lahore']

export const LOCATION_LABELS: Record<string, string> = {
  sheikhupura: 'Sheikhupura',
  lahore: 'Lahore',
}
