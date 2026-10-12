import type { MovementLike } from '@/lib/stock-math'

/**
 * Whether a movement puts cost onto the shelf or takes it off (SPEC §5.7).
 *
 * The inventory valuation identity needs one thing the pool derivation does
 * not: the COST direction of each movement, so "cost added by purchases minus
 * cost removed by sales and losses" can be compared with "units available ×
 * weighted average cost". That comparison is what makes the calculation panel
 * auditable rather than decorative, so the direction table lives here, next to
 * `movementEffects`, where a new movement type has to be classified on purpose.
 *
 *   add    — units (and their cost basis) enter sellable stock
 *   remove — sellable stock loses units and their cost basis
 *   neutral — value moves location, nothing enters or leaves
 *
 * Reversals are NOT handled here: a reversal keeps its own direction and
 * contributes a negative amount, which is arithmetically identical to the
 * opposite direction and keeps the ledger's own sign convention visible.
 */
export type CostDirection = 'add' | 'remove' | 'neutral'

export const costDirection = (m: MovementLike): CostDirection => {
  switch (m.movementType) {
    case 'purchase_in':
      return 'add'
    case 'return_restock':
      // The unit is sellable again, so its cost basis is back on the shelf.
      return 'add'
    case 'adjustment':
      return m.direction === 'out' ? 'remove' : 'add'
    case 'sale_out':
      return 'remove'
    case 'damage':
    case 'writeoff':
    case 'return_damaged':
    case 'return_writeoff':
      // Damaged and written-off units are no longer sellable stock, so they are
      // not in `available × cost`. Excluding them here is what lets the
      // valuation identity close; the losses panel shows them separately.
      return 'remove'
    case 'transfer':
      // Same units, same cost, different room. Neither a purchase nor a sale.
      return 'neutral'
  }
}

/** Per-product cost accumulation used by the valuation reconciliation. */
export interface CostFlow {
  /** Paisa added to sellable stock across all history. */
  added: number
  /** Paisa removed from sellable stock across all history. */
  removed: number
  /** Purchases that restated the weighted average — bounds the rounding error. */
  restatements: number
}

export const emptyCostFlow = (): CostFlow => ({ added: 0, removed: 0, restatements: 0 })

/**
 * Signed cost of one movement in paisa: `quantity × unitCost`, negated on a
 * reversal. A missing snapshot is treated as zero rather than guessed from the
 * product's CURRENT cost — the ledger either recorded the basis at the time or
 * it did not, and inventing one would silently rewrite history.
 */
export const movementCostAmount = (m: MovementLike): number =>
  (m.isReversal ? -1 : 1) * m.quantity * (m.unitCost ?? 0)
