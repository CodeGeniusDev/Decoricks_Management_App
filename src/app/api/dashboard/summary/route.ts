import { handleRouteError, withAuth } from '@/lib/http'
import { authorizeAllViews } from '@/lib/authorization'
import { getDatabase, withMongoRetry } from '@/lib/mongodb'
import { formatPaisa } from '@/lib/money'
import { getKarachiDate } from '@/lib/date'
import { errorResponse, successResponse } from '@/lib/api-response'
import { maybeRunNotificationSweep } from '@/lib/notifications/sweep'

/**
 * GET /api/dashboard/summary
 *
 * One read-only aggregate that backs the dashboard. Every figure is computed
 * from the stored collections — the dashboard used to render three hardcoded
 * chart series ("Oct 1 / PKR 15,700", a fixed stock-by-location table and a
 * single profit row) regardless of what was actually in the database.
 *
 * With an empty database the response contains empty arrays and zeros, which is
 * a truthful zero rather than a placeholder.
 */
async function __GET() {
  try {
    await authorizeAllViews(['finance', 'inventory', 'sales', 'tasks'])

    // Fire-and-forget the lazy time-sweep so overdue / due-soon / low-stock catch
    // up on a normal dashboard load, not only when the bell is opened. Deliberately
    // NOT awaited here — it must never add latency to the dashboard, and the live
    // signal updates the bell the moment the new rows land. Never rejects.
    void getDatabase()
      .then((db) => maybeRunNotificationSweep(db))
      .catch(() => undefined)

    const now = getKarachiDate()

    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const sevenDaysAgo = new Date(startOfToday.getTime() - 6 * 86_400_000)
    const thirtyDaysAgo = new Date(startOfToday.getTime() - 29 * 86_400_000)

    const [
      income7d,
      expenses7d,
      stockByLocation,
      profitByDay,
      openTasks,
      ordersAgg,
      stockValueAgg,
    ] = await withMongoRetry(async () => {
      const db = await getDatabase()
      return Promise.all([
      db
        .collection('income')
        .aggregate([
          { $match: { date: { $gte: sevenDaysAgo, $lte: now } } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
              total: { $sum: '$amount' },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
      db
        .collection('expenses')
        .aggregate([
          { $match: { date: { $gte: sevenDaysAgo, $lte: now } } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
              total: { $sum: '$amount' },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
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
              _id: '$location',
              units: { $sum: '$quantity' },
              // cost is stored in paisa
              value: { $sum: { $multiply: ['$quantity', { $ifNull: ['$product.cost', 0] }] } },
            },
          },
        ])
        .toArray(),
      db
        .collection('orders')
        .aggregate([
          // Cancelled orders are not revenue, so they are excluded here just
          // as they are from the lifetime totals.
          {
            $match: {
              createdAt: { $gte: thirtyDaysAgo, $lte: now },
              orderStatus: { $ne: 'cancelled' },
            },
          },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              // total is stored in paisa
              revenue: { $sum: '$total' },
              orders: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
      db.collection('tasks').countDocuments({ status: { $in: ['todo', 'in_progress', 'review'] } }),
      db
        .collection('orders')
        .aggregate([
          { $match: { orderStatus: { $ne: 'cancelled' } } },
          { $group: { _id: null, revenue: { $sum: '$total' }, count: { $sum: 1 } } },
        ])
        .toArray(),
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
      ])
    })

    // Merge the two 7-day series into one row per day so the chart lines up.
    const incomeByDay = new Map(income7d.map((r) => [r._id as string, r.total as number]))
    const expenseByDay = new Map(expenses7d.map((r) => [r._id as string, r.total as number]))
    const days = [...new Set([...incomeByDay.keys(), ...expenseByDay.keys()])].sort()

    const revenueTrend = days.map((day) => ({
      date: day,
      income: incomeByDay.get(day) ?? 0,
      expenses: expenseByDay.get(day) ?? 0,
    }))

    const locationLabels: Record<string, string> = { sheikhupura: 'Sheikhupura', lahore: 'Lahore' }

    interface AggregateRow {
      _id: string
      total?: number
      revenue?: number
      orders?: number
      units?: number
      value?: number
    }

    return successResponse({
      generatedAt: now.toISOString(),
      counts: {
        openTasks,
        orders: (ordersAgg[0]?.count as number) ?? 0,
      },
      revenueTrend7d: revenueTrend,
      ordersTrend30d: (profitByDay as AggregateRow[]).map((r) => ({
        date: r._id as string,
        revenue: (r.revenue as number) ?? 0,
        orders: (r.orders as number) ?? 0,
      })),
      stockByLocation: (stockByLocation as AggregateRow[]).map((r) => ({
        location: r._id as string,
        label: locationLabels[r._id as string] ?? (r._id as string),
        units: (r.units as number) ?? 0,
        valuePaisa: (r.value as number) ?? 0,
        valueDisplay: formatPaisa((r.value as number) ?? 0),
      })),
      stockValuePaisa: (stockValueAgg[0]?.value as number) ?? 0,
      stockValueDisplay: formatPaisa((stockValueAgg[0]?.value as number) ?? 0),
      lifetimeOrderRevenuePaisa: (ordersAgg[0]?.revenue as number) ?? 0,
      lifetimeOrderRevenueDisplay: formatPaisa((ordersAgg[0]?.revenue as number) ?? 0),
    })
  } catch (error) {
    console.error('GET /api/dashboard/summary failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
