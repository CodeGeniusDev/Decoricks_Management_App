import { handleRouteError, withAuth } from '@/lib/http'
import { authorizeAllViews } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase, withMongoRetry } from '@/lib/mongodb'
import { formatPaisa } from '@/lib/money'
import { transactionEffect } from '@/lib/finance'
import {
  getKarachiDate,
  getStartOfWeek,
  getEndOfWeek,
  getStartOfMonth,
  getEndOfMonth,
} from '@/lib/date'
import { errorResponse, successResponse, validationError } from '@/lib/api-response'
import { getLedgerCollection } from '@/lib/models/Ledger'
import { normalizeEntry } from '@/lib/finance-ledger'
import { computeProfitLoss } from '@/lib/profit-loss'
import { periodCogsInput } from '@/lib/cogs-service'
import { fetchLedgerRange } from '@/lib/distribution-service'
import { getStockCollection, getProductCollection } from '@/lib/models/Product'

const LOW_STOCK_FALLBACK = 5

/**
 * GET /api/reports/period?period=week|month&date=YYYY-MM-DD
 *
 * Backs the weekly/monthly summary. Every number is aggregated from stored
 * documents. Since Phase 3 the single source of money truth is the unified
 * ledger (`transactions`), and since Phase 5 COGS is derived from the stock
 * movement ledger — this report reads both directly so its P&L chain always
 * agrees with the Profit & Loss screen, the cash flow and inventory
 * valuation, instead of re-inventing its own approximations.
 *
 * Monetary values are paisa throughout and are formatted here for display.
 */
async function __GET(request: NextRequest) {
  try {
    await authorizeAllViews(['finance', 'inventory', 'sales', 'tasks'])

    const { searchParams } = new URL(request.url)
    const period = searchParams.get('period') === 'month' ? 'month' : 'week'
    const dateParam = searchParams.get('date')

    if (dateParam && !/^\d{4}-\d{2}-\d{2}/.test(dateParam)) {
      return errorResponse('Invalid date', 400, 'VALIDATION_ERROR')
    }

    const anchor = dateParam ? new Date(dateParam) : getKarachiDate()

    // Reuse the shared Asia/Karachi helpers so the report boundaries match the
    // rest of the app (Monday-based weeks, calendar months) instead of
    // re-deriving them against the server's local timezone.
    const rangeStart = period === 'week' ? getStartOfWeek(anchor) : getStartOfMonth(anchor)
    const rangeEnd = period === 'week' ? getEndOfWeek(anchor) : getEndOfMonth(anchor)

    const inRange = { $gte: rangeStart, $lte: rangeEnd }

    const [ledgerEntries, suppliedCogs, orderAgg, codAgg, orderRows, tasksDone, tasksByAssignee] =
      await withMongoRetry(async () => {
        const db = await getDatabase()
        const [entries, cogs] = await Promise.all([
          fetchLedgerRange(db, { start: rangeStart, end: rangeEnd }),
          periodCogsInput(db, { start: rangeStart, end: rangeEnd }),
        ])
        const [ordersA, codA, orderRowsA, tasksDoneA, tasksAssigneeA] = await Promise.all([
          db
            .collection('orders')
            .aggregate([
              { $match: { createdAt: inRange, orderStatus: { $ne: 'cancelled' } } },
              { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$total' } } },
            ])
            .toArray(),
          db
            .collection('orders')
            .aggregate([{ $match: { createdAt: inRange } }, { $group: { _id: '$codOutcome', count: { $sum: 1 } } }])
            .toArray(),
          db.collection('orders').find({ createdAt: inRange }).sort({ createdAt: -1 }).limit(50).toArray(),
          db.collection('tasks').countDocuments({ status: 'done', updatedAt: inRange }),
          db
            .collection('tasks')
            .aggregate([
              { $match: { status: 'done', updatedAt: inRange } },
              { $group: { _id: '$assigneeName', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ])
            .toArray(),
        ])
        return [entries, cogs, ordersA, codA, orderRowsA, tasksDoneA, tasksAssigneeA] as const
      })

    // The full SPEC §5 chain over the period; COGS is the real movement-based
    // figure, with the explicitly provisional purchasing stand-in only while
    // no inventory movements exist yet.
    const pl = computeProfitLoss(ledgerEntries, { cogs: suppliedCogs })

    const expenseLines = new Map<string, { amount: number; count: number }>()
    for (const entry of ledgerEntries) {
      if (entry.type !== 'expense' || !entry.category) continue
      const line = expenseLines.get(entry.category) ?? { amount: 0, count: 0 }
      line.amount += transactionEffect(entry).expense
      line.count += 1
      expenseLines.set(entry.category, line)
    }
    const byCategory = [...expenseLines.entries()]
      .map(([category, line]) => ({ category, amount: line.amount }))
      .sort((a, b) => b.amount - a.amount)
    const expenseTotal = byCategory.reduce((sum, r) => sum + r.amount, 0)

    const recentExpenseIds = ledgerEntries
      .filter((e) => e.type === 'expense')
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 50)
    const recentExpenseDocs = recentExpenseIds.length
      ? await withMongoRetry(async () => {
          const db = await getDatabase()
          return getLedgerCollection(db)
            .find({ _id: { $in: recentExpenseIds.map((e) => new ObjectId(String(e._id))) } } as never)
            .toArray()
        })
      : []
    const expenseById = new Map(recentExpenseDocs.map((d) => [d._id!.toString(), d]))

    const orders = (orderAgg[0]?.orders as number) ?? 0
    const revenue = (orderAgg[0]?.revenue as number) ?? 0

    const codCounts = new Map(
      (codAgg as Array<{ _id: string; count: number }>).map((r) => [r._id, r.count])
    )
    const codDelivered = codCounts.get('delivered') ?? 0
    const codReturned = codCounts.get('returned') ?? 0
    const codRefused = codCounts.get('refused') ?? 0
    const codSettled = codDelivered + codReturned + codRefused

    // Inventory: the stock rows are the movement-maintained projection of
    // available units; valuation is units × weighted-average cost. Low stock
    // is per product across BOTH locations against its own reorder level.
    const { inventoryValue, lowStockItems } = await withMongoRetry(async () => {
      const db = await getDatabase()
      const [stockRows, productRows] = await Promise.all([
        getStockCollection(db).find({}).toArray(),
        getProductCollection(db).find({ isActive: true } as never).toArray(),
      ])
      const productById = new Map(productRows.map((p) => [p._id!.toString(), p]))

      let value = 0
      const perProduct = new Map<string, number>()
      for (const row of stockRows) {
        const product = productById.get(String(row.productId))
        if (!product) continue
        value += Math.max(row.quantity, 0) * product.cost
        perProduct.set(
          String(row.productId),
          (perProduct.get(String(row.productId)) ?? 0) + row.quantity
        )
      }

      const low = [...perProduct.entries()]
        .filter(([id, qty]) => {
          const product = productById.get(id)
          const threshold = product?.reorderLevel ?? LOW_STOCK_FALLBACK
          return threshold > 0 && qty <= threshold
        })
        .map(([id, qty]) => ({
          id,
          name: productById.get(id)?.name ?? 'Unknown product',
          quantity: qty,
        }))
        .sort((a, b) => a.quantity - b.quantity)
        .slice(0, 50)

      return { inventoryValue: value, lowStockItems: low }
    })

    return successResponse({
      period,
      rangeStart: rangeStart.toISOString(),
      rangeEnd: rangeEnd.toISOString(),
      salesSummary: {
        orders,
        revenue,
        revenueDisplay: formatPaisa(revenue),
        codDelivered,
        codReturned,
        codRefused,
        // A true 0 when nothing has settled yet, not a fabricated percentage.
        deliveryRate: codSettled > 0 ? Math.round((codDelivered / codSettled) * 1000) / 10 : 0,
      },
      expensesSummary: {
        total: expenseTotal,
        totalDisplay: formatPaisa(expenseTotal),
        byCategory: byCategory.map((r) => ({
          category: r.category,
          amount: r.amount,
          amountDisplay: formatPaisa(r.amount),
        })),
      },
      profitSummary: {
        gross: pl.grossProfit,
        grossDisplay: formatPaisa(pl.grossProfit),
        net: pl.netProfit,
        netDisplay: formatPaisa(pl.netProfit),
        // Movement-derived weighted-average cost of the units actually sold.
        cogs: pl.cogs,
        cogsDisplay: formatPaisa(pl.cogs),
        cogsProvisional: pl.cogsProvisional,
        netSales: pl.netSales,
        netSalesDisplay: formatPaisa(pl.netSales),
        refunds: pl.refunds,
        refundsDisplay: formatPaisa(pl.refunds),
        operatingExpenses: pl.operatingExpenses,
        operatingExpensesDisplay: formatPaisa(pl.operatingExpenses),
      },
      stockSummary: {
        totalValue: inventoryValue,
        totalValueDisplay: formatPaisa(inventoryValue),
        lowStockItems,
      },
      tasksCompleted: {
        count: tasksDone,
        byAssignee: (tasksByAssignee as unknown as Array<{ _id: string | null; count: number }>).map((r) => ({
          name: r._id ?? 'Unassigned',
          count: r.count,
        })),
      },
      recentOrders: (orderRows as Array<Record<string, unknown>>).map((o) => ({
        date: (o.createdAt as Date).toISOString(),
        orderNumber: o.orderNumber as string,
        customerName: o.customerName as string,
        total: o.total as number,
        totalDisplay: formatPaisa(o.total as number),
        orderStatus: o.orderStatus as string,
      })),
      recentExpenses: recentExpenseIds.map((entry) => {
        const doc = expenseById.get(String(entry._id))
        return {
          date: new Date(entry.date).toISOString(),
          category: entry.category ?? '',
          amount: Math.abs(entry.amount),
          amountDisplay: formatPaisa(Math.abs(entry.amount)),
          description: doc?.note ?? '',
        }
      }),
    })
  } catch (error) {
    console.error('GET /api/reports/period failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
