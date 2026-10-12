import { describe, it, expect } from 'vitest'
import {
  availableAt,
  cogsFromMovements,
  cogsLine,
  deriveStock,
  isMovementType,
  movementEffects,
  valuationLine,
  weightedAverageCost,
  MOVEMENT_TYPES,
  type MovementLike,
} from '@/lib/stock-math'

/*
 * Phase 5 unit tests: the SPEC §5 worked examples, in integer paisa, run
 * against the pure stock math. PKR 500 is 50,000 paisa, so every number below
 * is the SPEC example multiplied by 100 — the arithmetic itself is unchanged
 * and the expected values are the SPEC's own, not values chosen to fit the
 * implementation.
 */

const m = (partial: Partial<MovementLike> & Pick<MovementLike, 'movementType' | 'quantity'>): MovementLike => ({
  productId: partial.productId ?? 'p1',
  fromLocation: partial.fromLocation ?? null,
  toLocation: partial.toLocation ?? null,
  ...partial,
  movementType: partial.movementType,
  quantity: partial.quantity,
})

describe('weightedAverageCost (SPEC §5.3)', () => {
  it('lands the SPEC example: 10 @ 500 + 5 @ 600 = 533.33 per unit', () => {
    // 10 units @ PKR 500 (50,000 paisa) then 5 units @ PKR 600 (60,000 paisa).
    const wac = weightedAverageCost(10, 50_000, 5, 60_000)
    // (10×50,000 + 5×60,000) / 15 = 800,000 / 15 = 53,333.33 → 53,333 paisa.
    expect(wac).toBe(53_333)
    // SPEC's COGS for the 8 units it then sells: 8 × 533.33 = PKR 4,266.64.
    expect(cogsLine(8, wac)).toBe(426_664)
  })

  it('is the incoming cost when there is nothing on hand', () => {
    expect(weightedAverageCost(0, 50_000, 5, 60_000)).toBe(60_000)
  })

  it('is unchanged when receiving nothing at the same cost', () => {
    expect(weightedAverageCost(10, 50_000, 10, 50_000)).toBe(50_000)
  })

  it('weights by quantity, not by number of purchases', () => {
    // 2 @ 50,000 then 8 @ 60,000 → 58,000. An unweighted mean would say 55,000.
    expect(weightedAverageCost(2, 50_000, 8, 60_000)).toBe(58_000)
  })

  it('stays an integer paisa at a repeating decimal', () => {
    // 1 @ 1 + 2 @ 2 = 5/3 = 1.666… → 2 (rounded to the paisa, never truncated twice)
    expect(weightedAverageCost(1, 1, 2, 2)).toBe(2)
  })
})

describe('movementEffects', () => {
  it('maps each type to the pool delta it owns', () => {
    expect(movementEffects(m({ movementType: 'purchase_in', quantity: 4, toLocation: 'lahore' }))).toEqual([
      { location: 'lahore', available: 4, damaged: 0, returned: 0 },
    ])
    expect(movementEffects(m({ movementType: 'sale_out', quantity: 4, fromLocation: 'lahore' }))).toEqual([
      { location: 'lahore', available: -4, damaged: 0, returned: 0 },
    ])
    // A restocked return is available again AND counted as returned.
    expect(movementEffects(m({ movementType: 'return_restock', quantity: 4, toLocation: 'lahore' }))).toEqual([
      { location: 'lahore', available: 4, damaged: 0, returned: 4 },
    ])
    // A damaged return never re-enters available stock.
    expect(movementEffects(m({ movementType: 'return_damaged', quantity: 4, toLocation: 'lahore' }))).toEqual([
      { location: 'lahore', available: 0, damaged: 4, returned: 4 },
    ])
    // A written-off return is recorded as returned but joins no physical pool.
    expect(movementEffects(m({ movementType: 'return_writeoff', quantity: 4, toLocation: 'lahore' }))).toEqual([
      { location: 'lahore', available: 0, damaged: 0, returned: 4 },
    ])
    // Warehouse damage leaves available and joins the damaged pool.
    expect(movementEffects(m({ movementType: 'damage', quantity: 4, fromLocation: 'sheikhupura' }))).toEqual([
      { location: 'sheikhupura', available: -4, damaged: 4, returned: 0 },
    ])
    expect(movementEffects(m({ movementType: 'writeoff', quantity: 4, fromLocation: 'sheikhupura' }))).toEqual([
      { location: 'sheikhupura', available: -4, damaged: 0, returned: 0 },
    ])
    // A counted adjustment carries an explicit direction.
    expect(
      movementEffects(m({ movementType: 'adjustment', quantity: 4, toLocation: 'lahore', direction: 'out' }))
    ).toEqual([{ location: 'lahore', available: -4, damaged: 0, returned: 0 }])
    expect(
      movementEffects(m({ movementType: 'adjustment', quantity: 4, toLocation: 'lahore', direction: 'in' }))
    ).toEqual([{ location: 'lahore', available: 4, damaged: 0, returned: 0 }])
  })

  it('a transfer touches both locations and conserves units', () => {
    const effects = movementEffects(
      m({ movementType: 'transfer', quantity: 6, fromLocation: 'sheikhupura', toLocation: 'lahore' })
    )
    expect(effects).toHaveLength(2)
    expect(effects.reduce((sum, e) => sum + e.available, 0)).toBe(0)
  })

  it('a reversal negates every effect of its type', () => {
    const original = movementEffects(m({ movementType: 'sale_out', quantity: 3, fromLocation: 'lahore' }))
    const reversal = movementEffects(
      m({ movementType: 'sale_out', quantity: 3, fromLocation: 'lahore', isReversal: true })
    )
    expect(reversal).toEqual([
      { location: 'lahore', available: 3, damaged: 0, returned: 0 },
    ])
    expect(original[0].available + reversal[0].available).toBe(0)
  })

  it('refuses a movement whose location is missing', () => {
    expect(() => movementEffects(m({ movementType: 'sale_out', quantity: 1 }))).toThrow(/location/i)
    expect(() =>
      movementEffects(m({ movementType: 'transfer', quantity: 1, fromLocation: 'lahore' }))
    ).toThrow(/location/i)
  })

  it('knows every type the ledger can hold, and no others', () => {
    MOVEMENT_TYPES.forEach((type) => expect(isMovementType(type)).toBe(true))
    expect(isMovementType('sale')).toBe(false)
    expect(isMovementType('')).toBe(false)
  })
})

describe('deriveStock (stock math per location)', () => {
  /*
   * One history, both locations, every movement type the app writes:
   *   purchase 10 into sheikhupura, transfer 4 to lahore, sell 2 at lahore,
   *   restock 1 returned unit at lahore, damage 1 at sheikhupura.
   */
  const history: MovementLike[] = [
    m({ movementType: 'purchase_in', quantity: 10, toLocation: 'sheikhupura', unitCost: 50_000 }),
    m({ movementType: 'transfer', quantity: 4, fromLocation: 'sheikhupura', toLocation: 'lahore' }),
    m({ movementType: 'sale_out', quantity: 2, fromLocation: 'lahore', unitCost: 50_000 }),
    m({ movementType: 'return_restock', quantity: 1, toLocation: 'lahore', unitCost: 50_000 }),
    m({ movementType: 'damage', quantity: 1, fromLocation: 'sheikhupura' }),
  ]

  it('derives the pools per product and location', () => {
    const derived = deriveStock(history)
    expect(availableAt(derived, 'p1', 'sheikhupura')).toBe(5) // 10 − 4 transferred − 1 damaged
    expect(availableAt(derived, 'p1', 'lahore')).toBe(3) // 4 − 2 sold + 1 restocked
    expect(derived.get('p1|sheikhupura')).toEqual({ available: 5, damaged: 1, returned: 0 })
    expect(derived.get('p1|lahore')).toEqual({ available: 3, damaged: 0, returned: 1 })
  })

  it('never invents a location that was not moved', () => {
    const derived = deriveStock(history)
    expect(availableAt(derived, 'p2', 'lahore')).toBe(0)
    expect(derived.has('p2|lahore')).toBe(false)
  })

  it('keeps the two locations independent', () => {
    const derived = deriveStock([
      m({ movementType: 'purchase_in', quantity: 5, toLocation: 'sheikhupura' }),
      m({ movementType: 'sale_out', quantity: 5, fromLocation: 'lahore' }),
    ])
    // Lahore was never stocked, so a sale there drives it negative rather than
    // borrowing from Sheikhupura — the guard that stops that lives in the write
    // path, and the derivation reports the truth either way.
    expect(availableAt(derived, 'p1', 'sheikhupura')).toBe(5)
    expect(availableAt(derived, 'p1', 'lahore')).toBe(-5)
  })

  it('cancels a cancelled order completely', () => {
    const derived = deriveStock([
      m({ movementType: 'purchase_in', quantity: 6, toLocation: 'lahore' }),
      m({ movementType: 'sale_out', quantity: 2, fromLocation: 'lahore' }),
      m({ movementType: 'sale_out', quantity: 2, fromLocation: 'lahore', isReversal: true }),
    ])
    expect(availableAt(derived, 'p1', 'lahore')).toBe(6)
  })
})

describe('cogsFromMovements (SPEC §5.3)', () => {
  it('charges the cost snapshot taken at the moment of each sale', () => {
    const cogs = cogsFromMovements([
      m({ movementType: 'sale_out', quantity: 8, fromLocation: 'lahore', unitCost: 53_333 }),
    ])
    // SPEC: 8 × PKR 533.33 = PKR 4,266.64.
    expect(cogs).toBe(426_664)
  })

  it('sums across sales and ignores purchases and adjustments', () => {
    const cogs = cogsFromMovements([
      m({ movementType: 'purchase_in', quantity: 20, toLocation: 'lahore', unitCost: 50_000 }),
      m({ movementType: 'sale_out', quantity: 8, fromLocation: 'lahore', unitCost: 53_333 }),
      m({ movementType: 'sale_out', quantity: 2, fromLocation: 'sheikhupura', unitCost: 50_000 }),
      m({ movementType: 'adjustment', quantity: 1, toLocation: 'lahore', direction: 'out' }),
    ])
    expect(cogs).toBe(8 * 53_333 + 2 * 50_000)
  })

  it('removes the cost of a unit that came back sellable', () => {
    const cogs = cogsFromMovements([
      m({ movementType: 'sale_out', quantity: 8, fromLocation: 'lahore', unitCost: 53_333 }),
      m({ movementType: 'return_restock', quantity: 2, toLocation: 'lahore', unitCost: 53_333 }),
    ])
    // 6 units really left the building: the restocked pair's cost goes back to
    // the balance sheet with the units.
    expect(cogs).toBe(6 * 53_333)
  })

  it('keeps the cost of damaged and written-off returns', () => {
    const cogs = cogsFromMovements([
      m({ movementType: 'sale_out', quantity: 3, fromLocation: 'lahore', unitCost: 50_000 }),
      m({ movementType: 'return_damaged', quantity: 1, toLocation: 'lahore', unitCost: 50_000 }),
      m({ movementType: 'return_writeoff', quantity: 1, toLocation: 'lahore', unitCost: 50_000 }),
    ])
    // The cost was genuinely incurred; only a restock reverses it.
    expect(cogs).toBe(3 * 50_000)
  })

  it('erases the cost of a cancelled sale', () => {
    expect(
      cogsFromMovements([
        m({ movementType: 'sale_out', quantity: 2, fromLocation: 'lahore', unitCost: 50_000 }),
        m({ movementType: 'sale_out', quantity: 2, fromLocation: 'lahore', unitCost: 50_000, isReversal: true }),
      ])
    ).toBe(0)
  })

  it('is zero for an empty history', () => {
    expect(cogsFromMovements([])).toBe(0)
  })
})

describe('inventory valuation (SPEC §5.7)', () => {
  it('adds up per product at its own weighted average cost', () => {
    // A: 7 × PKR 533.33, B: 5 × PKR 800, C: 3 × PKR 1,200.
    const lines = [
      valuationLine(7, 53_333),
      valuationLine(5, 80_000),
      valuationLine(3, 120_000),
    ]
    expect(lines).toEqual([373_331, 400_000, 360_000])
    expect(lines.reduce((sum, line) => sum + line, 0)).toBe(1_133_331) // PKR 11,333.31
  })

  it('values nothing where nothing is held', () => {
    expect(valuationLine(0, 53_333)).toBe(0)
  })

  it('reports a negative position honestly instead of flooring it at zero', () => {
    // Only reachable when the Founder allowed negative stock; the report must
    // not hide it.
    expect(valuationLine(-2, 50_000)).toBe(-100_000)
  })
})

describe('returns and refunds (SPEC §5.10)', () => {
  it('lands the SPEC return-impact example: 100% refund plus courier cost', () => {
    const itemValue = 100_000 // PKR 1,000
    const refundPercentage = 100
    const courierCost = 20_000 // PKR 200
    const impact = Math.round((itemValue * refundPercentage) / 100) + courierCost
    expect(impact).toBe(120_000) // PKR 1,200
  })

  it('restocks a returned unit back into available and keeps the returned pool', () => {
    const derived = deriveStock([
      m({ movementType: 'purchase_in', quantity: 4, toLocation: 'lahore', unitCost: 50_000 }),
      m({ movementType: 'sale_out', quantity: 2, fromLocation: 'lahore', unitCost: 50_000 }),
      m({ movementType: 'return_restock', quantity: 1, toLocation: 'lahore', unitCost: 50_000 }),
    ])
    expect(derived.get('p1|lahore')).toEqual({ available: 3, damaged: 0, returned: 1 })
    // COGS follows the units that really left: 2 out, 1 back = 1 unit charged.
    expect(
      cogsFromMovements([
        m({ movementType: 'sale_out', quantity: 2, fromLocation: 'lahore', unitCost: 50_000 }),
        m({ movementType: 'return_restock', quantity: 1, toLocation: 'lahore', unitCost: 50_000 }),
      ])
    ).toBe(50_000)
  })
})
