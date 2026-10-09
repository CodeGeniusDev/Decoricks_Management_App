import { handleRouteError, withAuth } from '@/lib/http'
import { authorizeAllViews } from '@/lib/authorization'
import { NextRequest } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDatabase, withMongoRetry } from '@/lib/mongodb'
import { formatPaisa } from '@/lib/money'
import {
  getKarachiDate,
  getStartOfWeek,
  getEndOfWeek,
  getStartOfMonth,
  getEndOfMonth,
} from '@/lib/date'
import { errorResponse, successResponse, validationError } from '@/lib/api-response'

const LOW_STOCK_THRESHOLD = 5

/**
 * GET /api/reports/period?period=week|month&date=YYYY-MM-DD
 *
 * Backs the weekly/monthly summary. Every number is aggregated from stored
 * documents; the page previously returned a fixed report (42 orders,
 * PKR 15,000 revenue, 12 completed tasks) no matter what was in the database.
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
      return validationError('Invalid date', [
        { path: 'date', message: 'Date must be YYYY-MM-DD' },
      ])
    }

    const anchor = dateParam ? new Date(dateParam) : getKarachiDate()

    // Reuse the shared Asia/Karachi helpers so the report boundaries match the
    // rest of the app (Monday-based weeks, calendar months) instead of
    // re-deriving them against the server's local timezone.
    const rangeStart =
      period === 'week' ? getStartOfWeek(anchor) : getStartOfMonth(anchor)
    const rangeEnd = period === 'week' ? getEndOfWeek(anchor) : getEndOfMonth(anchor)

    const inRange = { $gte: rangeStart, $lte: rangeEnd }

    const [
      orderAgg,
      codAgg,
      orderRows,
      expenseAgg,
      expenseRows,
      cogsAgg,
      inventoryValueAgg,
      lowStockRows,
      tasksDone,
      tasksByAssignee,
    ] = await withMongoRetry(async () => {
      const db = await getDatabase()
      return Promise.all([
      db
        .collection('orders')
        .aggregate([
          { $match: { createdAt: inRange, orderStatus: { $ne: 'cancelled' } } },
          { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$total' } } },
        ])
        .toArray(),
      db
        .collection('orders')
        .aggregate([
          { $match: { createdAt: inRange } },
          { $group: { _id: '$codOutcome', count: { $sum: 1 } } },
        ])
        .toArray(),
      db
        .collection('orders')
        .find({ createdAt: inRange })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray(),
      db
        .collection('expenses')
        .aggregate([
          { $match: { date: inRange } },
          { $group: { _id: '$category', amount: { $sum: '$amount' } } },
          { $sort: { amount: -1 } },
        ])
        .toArray(),
      db
        .collection('expenses')
        .find({ date: inRange })
        .sort({ date: -1 })
        .limit(50)
        .toArray(),
      // Cost of goods sold for the period: only units actually sold, valued at
      // the product's stored cost. Stock still sitting on hand is inventory, not
      // an expense, so it must not be subtracted from revenue.
      db
        .collection('orders')
        .aggregate([
          { $match: { createdAt: inRange, orderStatus: { $ne: 'cancelled' } } },
          { $unwind: '$items' },
          {
            $lookup: {
              from: 'products',
              localField: 'items.productId',
              foreignField: '_id',
              as: 'product',
            },
          },
          { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
          {
            $group: {
              _id: null,
              cogs: {
                $sum: { $multiply: ['$items.quantity', { $ifNull: ['$product.cost', 0] }] },
              },
            },
          },
        ])
        .toArray(),
      // Inventory on hand, valued at cost. This is a balance-sheet figure and is
      // reported separately from profit.
      db
        .collection('stock')
        .aggregate([
          {
            $lookup: {
              from: 'products',
              localField: 'productId',
              foreignField: '_id',
              as: 'product',
            },
          },
          { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
          {
            $group: {
              _id: null,
              value: { $sum: { $multiply: ['$quantity', { $ifNull: ['$product.cost', 0] }] } },
            },
          },
        ])
        .toArray(),
      db
        .collection('stock')
        .find({ quantity: { $gt: 0, $lte: LOW_STOCK_THRESHOLD } })
        .limit(50)
        .toArray(),
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
    })

    const orders = (orderAgg[0]?.orders as number) ?? 0
    const revenue = (orderAgg[0]?.revenue as number) ?? 0

    const codCounts = new Map(
      (codAgg as Array<{ _id: string; count: number }>).map((r) => [r._id, r.count])
    )
    const codDelivered = codCounts.get('delivered') ?? 0
    const codReturned = codCounts.get('returned') ?? 0
    const codRefused = codCounts.get('refused') ?? 0
    const codSettled = codDelivered + codReturned + codRefused

    const expenseTotal = (expenseAgg as Array<{ _id: string; amount: number }>).reduce(
      (sum, r) => sum + r.amount,
      0
    )
    const cogs = (cogsAgg[0]?.cogs as number) ?? 0
    const inventoryValue = (inventoryValueAgg[0]?.value as number) ?? 0
    const gross = revenue - cogs
    const net = gross - expenseTotal

    const lowStockProducts = new Map(
      (lowStockRows as unknown as Array<{ productId: unknown; quantity: number }>).map((r) => [
        String(r.productId),
        r.quantity,
      ])
    )
    const lowStockIds = [...lowStockProducts.keys()].filter((id) => /^[0-9a-fA-F]{24}$/.test(id))
    const lowStockProductDocs = lowStockIds.length
      ? await withMongoRetry(async () => {
          const database = await getDatabase()
          return database
            .collection('products')
            .find({ _id: { $in: lowStockIds.map((id) => new ObjectId(id)) } } as never)
            .toArray()
        })
      : []

    const nameById = new Map(
      lowStockProductDocs.map((p: { _id: unknown; name?: string }) => [String(p._id), p.name as string])
    )

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
        byCategory: (expenseAgg as Array<{ _id: string; amount: number }>).map((r) => ({
          category: r._id,
          amount: r.amount,
          amountDisplay: formatPaisa(r.amount),
        })),
      },
      profitSummary: {
        gross,
        grossDisplay: formatPaisa(gross),
        net,
        netDisplay: formatPaisa(net),
        // Units sold in the period valued at stored product cost.
        cogs,
        cogsDisplay: formatPaisa(cogs),
      },
      stockSummary: {
        totalValue: inventoryValue,
        totalValueDisplay: formatPaisa(inventoryValue),
        lowStockItems: [...lowStockProducts.entries()].map(([id, quantity]) => ({
          name: nameById.get(id) ?? 'Unknown product',
          quantity,
        })),
        recentTransfers: 0,
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
      recentExpenses: (expenseRows as unknown as Array<Record<string, unknown>>).map((e) => ({
        date: (e.date as Date).toISOString(),
        category: e.category as string,
        amount: e.amount as number,
        amountDisplay: formatPaisa(e.amount as number),
        description: (e.description as string) ?? '',
      })),
    })
  } catch (error) {
    console.error('GET /api/reports/period failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
