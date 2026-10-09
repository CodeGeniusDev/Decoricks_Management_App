import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'

/**
 * Tests for GET /api/reports/period, the real backing query for the weekly and
 * monthly summary.
 *
 * Two bugs are pinned here:
 *  1. The period boundaries were hand-derived with `setDate(rangeStart.getDate()
 *     + 6)`, which used the day-of-month and produced a five-week window. The
 *     route must use the shared Asia/Karachi helpers instead.
 *  2. "COGS" was computed as the value of *all stock on hand*, which is an
 *     inventory balance rather than a cost of sales, and made profit read far
 *     too low. It must come from units actually sold.
 */

/** Chainable cursor stub: find().sort().limit().toArray() and find().sort().toArray() */
const cursor = (rows: unknown[] = []) => {
  const c: Record<string, unknown> = {
    sort: () => c,
    limit: () => c,
    toArray: async () => rows,
  }
  return c
}

/** Every aggregate pipeline the route executed, in call order. */
let pipelines: Array<Record<string, unknown>[]>
/** Every find() filter the route executed. */
let filters: Record<string, unknown>[]

const collection = () => ({
  aggregate: vi.fn((pipeline: Record<string, unknown>[]) => {
    pipelines.push(pipeline)
    return cursor([])
  }),
  find: vi.fn((filter: Record<string, unknown>) => {
    filters.push(filter)
    return cursor([])
  }),
  findOne: vi.fn(async () => null),
  countDocuments: vi.fn(async () => 0),
})

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => ({ collection: () => collection() })),
  // The route wraps its aggregation pass in the shared retry helper; the mock
  // must expose it or every request 500s before reaching a query.
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

beforeEach(() => {
  vi.clearAllMocks()
  pipelines = []
  filters = []
})

const get = (query: string) =>
  new Request('http://localhost/api/reports/period' + query) as never

describe('GET /api/reports/period', () => {
  it('returns honest zeros for an empty period instead of a fixed report', async () => {
    const { GET } = await import('@/app/api/reports/period/route')
    const res = await GET(get('?period=week'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)

    const d = body.data
    expect(d.salesSummary.orders).toBe(0)
    expect(d.salesSummary.revenue).toBe(0)
    expect(d.salesSummary.revenueDisplay).toBe('PKR 0.00')
    expect(d.salesSummary.deliveryRate).toBe(0)
    expect(d.expensesSummary.byCategory).toEqual([])
    expect(d.profitSummary.net).toBe(0)
    expect(d.tasksCompleted.count).toBe(0)
    expect(d.recentOrders).toEqual([])
  })

  it('spans exactly one week', async () => {
    const { GET } = await import('@/app/api/reports/period/route')
    const res = await GET(get('?period=week'))
    const { rangeStart, rangeEnd } = (await res.json()).data

    const spanDays = (new Date(rangeEnd).getTime() - new Date(rangeStart).getTime()) / 86400000
    expect(spanDays).toBeCloseTo(7, 5)
    // Monday-based weeks, matching getStartOfWeek.
    expect(new Date(rangeStart).getDay()).toBe(1)
    expect(new Date(rangeEnd).getDay()).toBe(0)
  })

  it('spans one calendar month for period=month', async () => {
    const { GET } = await import('@/app/api/reports/period/route')
    const res = await GET(get('?period=month&date=2026-10-15'))
    const { rangeStart, rangeEnd } = (await res.json()).data

    expect(new Date(rangeStart).getDate()).toBe(1)
    expect(new Date(rangeEnd).getDate()).toBe(31)
  })

  it('rejects a malformed date', async () => {
    const { GET } = await import('@/app/api/reports/period/route')
    const res = await GET(get('?period=week&date=not-a-date'))
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toMatch(/invalid date/i)
  })

  it('excludes cancelled orders from revenue', async () => {
    const { GET } = await import('@/app/api/reports/period/route')
    await GET(get('?period=week'))

    const excludesCancelled = pipelines.some((p) =>
      p.some(
        (stage) =>
          (stage as { $match?: { orderStatus?: { $ne?: string } } }).$match?.orderStatus?.$ne ===
          'cancelled'
      )
    )
    expect(excludesCancelled).toBe(true)
  })

  it('derives COGS from sold units, not from total stock on hand', async () => {
    const { GET } = await import('@/app/api/reports/period/route')
    await GET(get('?period=week'))

    // The COGS pipeline must unwind order *items*. The old implementation never
    // did, which is why it reported total inventory on hand as a cost of sales.
    const cogsPipeline = pipelines.find((p) =>
      p.some((s) => (s as { $unwind?: string }).$unwind === '$items')
    )
    expect(cogsPipeline).toBeDefined()

    // It must read items.quantity multiplied by the joined product's cost.
    const group = cogsPipeline!.find(
      (s) => JSON.stringify(s).includes('items.quantity')
    ) as { $group: { cogs: { $sum: unknown } } }
    expect(group).toBeDefined()
    expect(JSON.stringify(group.$group.cogs.$sum)).toContain('product.cost')
  })
})