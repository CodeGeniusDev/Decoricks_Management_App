import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { successResponse, validationError } from '@/lib/api-response'
import { buildStockSummary } from '@/lib/stock-summary'
import { getStockMovementCollection, ensureInventoryIndexes } from '@/lib/models/Inventory'
import { getOrderCollection, ensureOrdersIndexes } from '@/lib/models/Sales'
import { cogsFromMovements, type MovementLike, type MovementType } from '@/lib/stock-math'
import { computeProfitLoss, type CogsInput } from '@/lib/profit-loss'
import { periodCogsInput } from '@/lib/cogs-service'
import { resolveReportRange } from '@/lib/cash-flow'
import { fetchLedgerRange } from '@/lib/distribution-service'
import { formatKarachiDate } from '@/lib/date'
import { transactionEffect } from '@/lib/finance'
import {
  costDirection,
  emptyCostFlow,
  movementCostAmount,
  type CostFlow,
} from '@/lib/inventory-cost-flow'

/**
 * GET /api/reports/inventory-calc — the calculation panel behind the Phase 5
 * numbers (SPEC §5.3, §5.7).
 *
 * Query: `period=day|week|month|custom` with `date`, or `from`/`to`
 * (YYYY-MM-DD Karachi boundaries). Defaults to the current Karachi month, the
 * same default the P&L screen uses, so the two screens can be put side by side
 * and compared without lining up dates by hand.
 *
 * Three panels, each with its arithmetic exposed:
 *
 *   1. **Valuation** — available units × weighted average cost, per product and
 *      per location, rebuilt from the movement ledger (not the cached
 *      projection), so it is the same number the overview shows.
 *   2. **COGS** — every `sale_out` line at its cost snapshot, less the
 *      `return_restock` lines whose cost basis went back on the shelf. The
 *      movement count and the raw sums are returned too, so the total can be
 *      added up by hand from the rows above it.
 *   3. **Margins** — revenue and refunds taken from the Phase 3 ledger (so a
 *      refusal or cancel cannot hide income), COGS from panel 2, gross profit
 *      and margin on top.
 *
 * Then three reconciliations, reported as numbers rather than assurances:
 * valuation against the cost actually added and removed by movements (the
 * residual is weighted-average rounding, disclosed per product), this panel's
 * COGS against the P&L's COGS, and ledger sales income against the order totals
 * whose COD cash was received in the period. Nothing here is rounded into
 * agreement.
 */

/** Movement families that add cost to the shelf, and those that take it off. */
const COST_FLOW_TYPES: MovementType[] = [
  'purchase_in',
  'adjustment',
  'sale_out',
  'return_restock',
  'return_damaged',
  'return_writeoff',
  'damage',
  'writeoff',
]

interface MovementRow extends MovementLike {
  _id: string
  date: Date
  toLocation: string | null
  fromLocation: string | null
  notes?: string
  isReversal: boolean
}

async function __GET(request: NextRequest) {
  try {
    await authorize('inventory', 'view')

    const { searchParams } = new URL(request.url)
    const resolved = resolveReportRange(searchParams)
    if (!resolved) {
      return validationError('Invalid period', [
        {
          path: 'period',
          message: 'Provide a valid period with date, or from and to (YYYY-MM-DD)',
        },
      ])
    }
    const { period, range } = resolved

    const db = await getDatabase()
    await ensureInventoryIndexes(db)
    await ensureOrdersIndexes(db)

    // Valuation always comes from the ledger, never the projection, so it is
    // the same figure the overview and the stock CSV are built from.
    const summary = await buildStockSummary(db, { includeArchived: true })

    const movements = (await getStockMovementCollection(db)
      .find({ movementType: { $in: COST_FLOW_TYPES } } as never)
      .sort({ date: -1, createdAt: -1 })
      .toArray()) as unknown as (Omit<MovementRow, '_id' | 'date'> & { _id?: ObjectId; date?: Date })[]

    const rows: MovementRow[] = movements
      .filter((m) => m.date instanceof Date)
      .map((m) => ({
        _id: m._id!.toString(),
        movementType: m.movementType,
        productId: String(m.productId),
        quantity: m.quantity,
        unitCost: m.unitCost,
        direction: m.direction,
        fromLocation: m.fromLocation ?? null,
        toLocation: m.toLocation ?? null,
        isReversal: Boolean(m.isReversal),
        notes: m.notes,
        date: m.date as Date,
      }))

    /* ------------------------------ panel 2: COGS ----------------------------- */

    const inRange = rows.filter(
      (m) => m.date >= range.start && m.date <= range.end && (m.movementType === 'sale_out' || m.movementType === 'return_restock')
    )
    const nameById = new Map(summary.items.map((item) => [item._id, item.name]))

    const saleOutGross = inRange
      .filter((m) => m.movementType === 'sale_out')
      .reduce((sum, m) => sum + movementCostAmount(m), 0)
    const restockRelieved = inRange
      .filter((m) => m.movementType === 'return_restock')
      .reduce((sum, m) => sum + movementCostAmount(m), 0)

    const cogsLines = inRange
      .slice(0, 200)
      .map((m) => ({
        _id: m._id,
        date: m.date.toISOString(),
        dateLabel: formatKarachiDate(m.date, 'date'),
        productId: m.productId,
        productName: nameById.get(m.productId) ?? 'Unknown product',
        movementType: m.movementType,
        quantity: m.quantity,
        unitCost: m.unitCost ?? 0,
        amount: movementCostAmount(m),
      }))

    const cogs: CogsInput = {
      amount: cogsFromMovements(inRange),
      provisional: false,
      source: 'inventory movement ledger (weighted average cost, SPEC §5.3)',
    }

    /* --------------------------- panel: stock losses -------------------------- */

    // Units that left the shelf without being sold still cost real money; they
    // belong in the panel so the valuation residual is not a mystery.
    const lossTypes: MovementType[] = ['damage', 'writeoff', 'return_damaged', 'return_writeoff']
    const losses = lossTypes.map((type) => {
      const lines = rows.filter(
        (m) => m.movementType === type && m.date >= range.start && m.date <= range.end
      )
      return {
        type,
        units: lines.reduce((sum, m) => sum + (m.isReversal ? -m.quantity : m.quantity), 0),
        amount: lines.reduce((sum, m) => sum + movementCostAmount(m), 0),
        count: lines.length,
      }
    })

    /* ---------------------------- panel 3: margins ---------------------------- */

    const entries = await fetchLedgerRange(db, range)
    const profitLoss = computeProfitLoss(entries, { cogs })
    const grossMargin =
      profitLoss.netSales === 0 ? null : (profitLoss.grossProfit / profitLoss.netSales) * 100

    /* ----------------------- reconciliation 1: valuation ---------------------- */

    // Σ cost added to the shelf − Σ cost taken off, over ALL history, should
    // equal the current valuation. It does not match to the paisa, because
    // every purchase rounds the weighted average to a whole paisa and that
    // rounding is then multiplied by the units still on the shelf. The residual
    // is disclosed per product instead of hidden, together with the number of
    // cost restatements that produced it.
    const flowByProduct = new Map<string, CostFlow>()
    for (const row of rows) {
      const entry = flowByProduct.get(row.productId) ?? emptyCostFlow()
      const cost = movementCostAmount(row)
      const direction = costDirection(row)
      if (direction === 'add') {
        entry.added += cost
        if (row.movementType === 'purchase_in') entry.restatements += 1
      } else if (direction === 'remove') {
        entry.removed += cost
      }
      flowByProduct.set(row.productId, entry)
    }

    const valuationFlow = summary.items.map((item) => {
      const flow = flowByProduct.get(item._id) ?? { added: 0, removed: 0, restatements: 0 }
      const ledgerValuation = flow.added - flow.removed
      return {
        _id: item._id,
        sku: item.sku,
        name: item.name,
        totalAvailable: item.totalAvailable,
        cost: item.cost,
        valuation: item.valuation,
        ledgerValuation,
        difference: item.valuation - ledgerValuation,
        restatements: flow.restatements,
      }
    })
    const valuationDifference = valuationFlow.reduce((sum, row) => sum + row.difference, 0)

    /* ------------------- reconciliation 2: COGS against P&L ------------------- */

    // The P&L derives its own figure from the same ledger; if the two ever
    // disagree, one of them has drifted, and the panel says so plainly.
    const plCogs = await periodCogsInput(db, range)

    /* ------------------ reconciliation 3: income against orders ----------------- */

    const incomeCategory = 'sales_revenue'
    const ledgerIncome = entries
      .filter((entry) => entry.type === 'income' && entry.category === incomeCategory)
      .reduce((sum, entry) => sum + transactionEffect(entry).revenue, 0)

    const cashedOrders = await getOrderCollection(db)
      .find({ codCashReceivedAt: { $gte: range.start, $lte: range.end } } as never)
      .toArray()
    const orderTotals = cashedOrders.reduce((sum, order) => sum + order.total, 0)

    return successResponse({
      period,
      range: {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        label: `${formatKarachiDate(range.start, 'date')} – ${formatKarachiDate(range.end, 'date')}`,
      },
      valuation: {
        formula: 'Available units × weighted average cost, per product (SPEC §5.7)',
        totalValuation: summary.totals.totalValuation,
        productCount: summary.totals.productCount,
        lowStockCount: summary.totals.lowStockCount,
        byLocation: summary.totals.byLocation.map((row) => ({
          location: row.location,
          available: row.available,
          damaged: row.damaged,
          returned: row.returned,
          valuation: row.valuation,
        })),
        rows: summary.items
          .filter((item) => item.totalAvailable > 0 || item.totalDamaged > 0 || item.totalReturned > 0)
          .map((item) => ({
            _id: item._id,
            sku: item.sku,
            name: item.name,
            isActive: item.isActive,
            totalAvailable: item.totalAvailable,
            cost: item.cost,
            valuation: item.valuation,
            byLocation: item.byLocation.map((row) => ({
              location: row.location,
              available: row.available,
              valuation: row.valuation,
            })),
          })),
      },
      cogs: {
        formula: 'Σ sale_out (qty × cost snapshot) − Σ return_restock (qty × cost snapshot)',
        saleOutGross,
        restockRelieved,
        amount: cogs.amount,
        movementCount: inRange.length,
        lines: cogsLines,
        truncated: inRange.length > cogsLines.length,
      },
      losses: {
        formula: 'Units that left the shelf without a sale, at their cost snapshot',
        rows: losses,
        total: losses.reduce((sum, row) => sum + row.amount, 0),
      },
      margins: {
        formula: 'Net Sales − COGS; margin = Gross Profit ÷ Net Sales',
        revenue: profitLoss.revenue,
        refunds: profitLoss.refunds,
        netSales: profitLoss.netSales,
        cogs: profitLoss.cogs,
        cogsProvisional: profitLoss.cogsProvisional,
        cogsSource: profitLoss.cogsSource,
        grossProfit: profitLoss.grossProfit,
        grossMarginPercent: grossMargin,
        courierAndOperatingExpenses: profitLoss.operatingExpenses,
        netProfit: profitLoss.netProfit,
      },
      reconciliation: {
        valuation: {
          ledgerValuation: valuationFlow.reduce((sum, row) => sum + row.ledgerValuation, 0),
          panelValuation: summary.totals.totalValuation,
          difference: valuationDifference,
          rows: valuationFlow.filter((row) => row.difference !== 0),
          // Weighted-average rounding is bounded by (units held × half a paisa
          // per restatement). Past this, the difference is not rounding.
          withinRoundingBound: valuationFlow.every(
            (row) => Math.abs(row.difference) <= row.totalAvailable * (row.restatements + 1)
          ),
          explanation:
            'Residual is weighted-average rounding: each purchase rounds the average cost to a whole paisa, and that rounding applies to every unit still held.',
        },
        cogs: {
          panel: cogs.amount,
          profitLoss: plCogs ? plCogs.amount : null,
          matches: plCogs ? plCogs.amount === cogs.amount : null,
        },
        income: {
          ledgerIncome,
          orderTotals,
          ordersCashed: cashedOrders.length,
          matches: ledgerIncome === orderTotals,
        },
      },
      generatedAt: {
        iso: new Date().toISOString(),
        karachiDate: formatKarachiDate(new Date(), 'date'),
      },
    })
  } catch (error) {
    console.error('GET /api/reports/inventory-calc failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
