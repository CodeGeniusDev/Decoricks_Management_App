import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'

/**
 * Tests for GET /api/reports/period, the real backing query for the weekly and
 * monthly summary.
 *
 * Bugs pinned here:
 *  1. The period boundaries were once hand-derived with `setDate(rangeStart.getDate()
 *     + 6)`, which used the day-of-month and produced a five-week window. The
 *     route must use the shared Asia/Karachi helpers instead.
 *  2. "COGS" was once computed as the value of *all stock on hand*, which is an
 *     inventory balance, not a cost of sales. Since Phase 5 it comes from the
 *     stock movement ledger (weighted average cost of the units actually sold).
 *  3. Money used to be read from the legacy `expenses` collection. Phase 3 put
 *     every amount in the unified ledger, so the report must read `transactions`.
 */

/** Chainable cursor stub: find().sort().limit().toArray() / .next() / aggregate().toArray() */
const cursor = (rows: unknown[] = []) => {
  const c: Record<string, unknown> = {
    sort: () => c,
    limit: () => c,
    skip: () => c,
    project: () => c,
    next: async () => (rows.length ? rows[0] : null),
    toArray: async () => rows,
  }
  return c
}

/** Every aggregate pipeline the route executed, in call order. */
let pipelines: Array<Record<string, unknown>[]>
/** Every find() filter the route executed, tagged with its collection. */
let queries: Array<{ name: string; filter: Record<string, unknown> }>
/** Seedable per-collection document stores. */
let docs: Record<string, unknown[]>

const collection = (name: string) => ({
  aggregate: vi.fn((pipeline: Record<string, unknown>[]) => {
    pipelines.push(pipeline)
    return cursor([])
  }),
  find: vi.fn((filter: Record<string, unknown> = {}) => {
    queries.push({ name, filter })
    const rows = docs[name] ?? []
    // Movements are fetched twice: a `find({})` existence probe and a typed,
    // date-bounded COGS query. Filter them here so both paths behave.
    if (name !== 'stockMovements' || rows.length === 0) return cursor(rows)
    const types = (filter as { movementType?: { $in?: string[] } })?.movementType?.$in
    const bounds = (filter as { date?: { $gte?: Date; $lte?: Date } })?.date
    return cursor(
      rows.filter((row) => {
        const r = row as { movementType?: string; date?: Date }
        if (types && !types.includes(String(r.movementType))) return false
        if (bounds?.$gte && r.date!.getTime() < bounds.$gte.getTime()) return false
        if (bounds?.$lte && r.date!.getTime() > bounds.$lte.getTime()) return false
        return true
      })
    )
  }),
  findOne: vi.fn(async () => null),
  countDocuments: vi.fn(async () => 0),
})

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => ({ collection: (name: string) => collection(name) })),
  // The route wraps its query passes in the shared retry helper; the mock must
  // expose it or every request 500s before reaching a query.
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

beforeEach(() => {
  vi.clearAllMocks()
  pipelines = []
  queries = []
  docs = { transactions: [], stockMovements: [], stock: [], products: [] }
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

  it('reads money from the unified ledger, not the legacy expenses collection', async () => {
    const { GET } = await import('@/app/api/reports/period/route')
    await GET(get('?period=week'))

    const ledgerNames = queries.map((q) => q.name)
    expect(ledgerNames).toContain('transactions')
    expect(ledgerNames).not.toContain('expenses')
  })

  it('derives COGS from the movement ledger, not from stock on hand', async () => {
    const { GET } = await import('@/app/api/reports/period/route')

    // Ask the route for its own window so the seeded movements are always
    // inside the period, whatever timezone the test runner lives in.
    const first = await GET(get('?period=week'))
    const { rangeStart, rangeEnd } = (await first.json()).data
    const inside = new Date((new Date(rangeStart).getTime() + new Date(rangeEnd).getTime()) / 2)

    const unitCost = 53_333 // paisa, the SPEC §5.3 weighted average
    docs.stockMovements = [
      {
        _id: new ObjectId(),
        productId: new ObjectId(),
        movementType: 'sale_out',
        quantity: 8,
        unitCost,
        date: inside,
        isReversal: false,
        status: 'posted',
      },
      {
        _id: new ObjectId(),
        productId: new ObjectId(),
        movementType: 'return_restock',
        quantity: 2,
        unitCost,
        date: inside,
        isReversal: false,
        status: 'posted',
      },
    ]

    const res = await GET(get('?period=week'))
    const body = await res.json()

    // The query must ask for the COGS-bearing movement family.
    const cogsQuery = queries.find((q) => {
      const types = (q.filter as { movementType?: { $in?: string[] } })?.movementType?.$in
      return q.name === 'stockMovements' && types?.includes('sale_out') && types.includes('return_restock')
    })
    expect(cogsQuery).toBeDefined()

    // 8 sold minus 2 restocked, at the recorded weighted average cost.
    expect(body.data.profitSummary.cogs).toBe(6 * unitCost)
    expect(body.data.profitSummary.cogsProvisional).toBe(false)

    // The old implementation never unwound order items into a cost of sales;
    // it reported inventory value. That path must be gone.
    const unwindsOrderItems = pipelines.some((p) =>
      p.some((s) => (s as { $unwind?: string }).$unwind === '$items')
    )
    expect(unwindsOrderItems).toBe(false)
  })

  it('keeps the COGS figure explicitly provisional while no movements exist at all', async () => {
    const { GET } = await import('@/app/api/reports/period/route')
    const res = await GET(get('?period=week'))
    const body = await res.json()

    expect(res.status).toBe(200)
    // A pre-Phase-5 database has no inventory history, so the report must say
    // so rather than pretending the cost of sales was zero.
    expect(body.data.profitSummary.cogsProvisional).toBe(true)
    expect(body.data.profitSummary.cogs).toBe(0)
  })
})
