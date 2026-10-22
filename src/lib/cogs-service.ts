import type { Db } from 'mongodb'
import { getStockMovementCollection } from '@/lib/models/Inventory'
import { FIRST_BATCH_SIZE } from '@/lib/mongo-read'
import { cogsFromMovements, type MovementLike } from '@/lib/stock-math'
import type { CogsInput } from '@/lib/profit-loss'
import type { DateRange } from '@/lib/finance'

/**
 * Real weighted-average COGS (Phase 5, SPEC §5.3).
 *
 * The P&L engine always deducted the cost of goods SOLD. Until now the only
 * number available was the `product_purchasing` ledger total — cost of goods
 * BOUGHT — which is wrong the moment stock carries over between months. This
 * module derives COGS from the append-only movement ledger instead:
 *
 *   COGS = Σ sale_out qty × unitCost − Σ return_restock qty × unitCost
 *
 * `unitCost` is the weighted-average snapshot written on the movement when the
 * event happened, so restated product costs can never rewrite history, and a
 * reversal movement cancels its original exactly.
 *
 * Before the first Phase 5 movement exists there is genuinely no inventory
 * data; then these helpers return `null` so the caller keeps the explicitly
 * PROVISIONAL ledger stand-in rather than a fake zero.
 */

const COGS_SOURCE = 'inventory movement ledger (weighted average cost, SPEC §5.3)'

/** The COGS-bearing movement family. */
const COGS_TYPES = ['sale_out', 'return_restock'] as const

interface MovementRow {
  movementType: (typeof COGS_TYPES)[number]
  productId: unknown
  quantity: number
  unitCost?: number
  isReversal?: boolean
  date: Date
}

async function hasAnyMovements(db: Db): Promise<boolean> {
  const row = await getStockMovementCollection(db).find({}).limit(1).next()
  return row !== null
}

const toLike = (row: MovementRow): MovementLike => ({
  movementType: row.movementType,
  productId: String(row.productId),
  quantity: row.quantity,
  unitCost: row.unitCost,
  isReversal: row.isReversal,
  date: row.date,
})

/**
 * COGS for one inclusive date range, or `null` when the app has no movement
 * history at all (pre-Phase 5 data — the caller falls back to provisional).
 */
export async function periodCogsInput(db: Db, range: DateRange): Promise<CogsInput | null> {
  /*
   * Both reads are issued together. Awaiting the existence guard first made this
   * path pay two round trips in series for a single answer — 132ms against the
   * 65ms a lone read costs on this cluster (`scripts/db-probe.ts`), and it paid
   * both even when the period had no rows. The guard still decides the result
   * exactly as before; the period read simply no longer waits for it.
   */
  const [any, rawRows] = await Promise.all([
    hasAnyMovements(db),
    getStockMovementCollection(db)
      .find({
        movementType: { $in: COGS_TYPES },
        date: { $gte: range.start, $lte: range.end },
      } as never)
      .batchSize(FIRST_BATCH_SIZE)
      .toArray(),
  ])
  if (!any) return null

  const rows = rawRows as unknown as MovementRow[]

  return {
    amount: cogsFromMovements(rows.map(toLike)),
    provisional: false,
    source: COGS_SOURCE,
  }
}

/**
 * COGS for many ranges in one pass — used by the 12-month P&L trend so the
 * chart gets real per-month COGS without twelve queries. Ranges may overlap;
 * each is filtered in memory from a single fetch.
 */
export async function cogsInputsForRanges(
  db: Db,
  ranges: DateRange[]
): Promise<(CogsInput | null)[]> {
  if (ranges.length === 0) return []

  const starts = ranges.map((r) => r.start.getTime())
  const ends = ranges.map((r) => r.end.getTime())
  const window = {
    start: new Date(Math.min(...starts)),
    end: new Date(Math.max(...ends)),
  }

  // Same reasoning as `periodCogsInput`: the guard decides the answer, but it no
  // longer makes the caller wait a whole round trip before the real read starts.
  const [any, rawRows] = await Promise.all([
    hasAnyMovements(db),
    getStockMovementCollection(db)
      .find({
        movementType: { $in: COGS_TYPES },
        date: { $gte: window.start, $lte: window.end },
      } as never)
      .batchSize(FIRST_BATCH_SIZE)
      .toArray(),
  ])
  if (!any) return ranges.map(() => null)

  const rows = rawRows as unknown as MovementRow[]

  return ranges.map((range) => {
    const inRange = rows.filter((row) => row.date >= range.start && row.date <= range.end)
    return {
      amount: cogsFromMovements(inRange.map(toLike)),
      provisional: false,
      source: COGS_SOURCE,
    }
  })
}
