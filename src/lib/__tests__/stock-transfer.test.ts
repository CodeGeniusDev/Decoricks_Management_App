import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'

/**
 * Regression tests for POST /api/stock/transfer.
 *
 * The original bug: the source row was decremented first and the destination
 * row incremented afterwards, so a failed second write silently destroyed the
 * transferred units. Both legs must now run in one transaction, and a failed
 * leg must not leave a partial transfer behind.
 */

const PRODUCT_ID = '507f1f77bcf86cd799439011'

const stockCollection = {
  find: vi.fn(),
  findOne: vi.fn(),
  updateOne: vi.fn(),
  insertOne: vi.fn(),
  createIndex: vi.fn(),
}

/** Records every updateOne call so we can assert ordering and session usage. */
const updateCalls: Array<{ filter: unknown; update: unknown; options: unknown }> = []

/** When set, the Nth updateOne (1-based) rejects to simulate a write failure. */
let failUpdateAt: number | null = null

const withTransaction = vi.fn(async (fn: (session: unknown) => Promise<void>) => {
  await fn({ id: 'session' })
})

const startSession = vi.fn(() => ({
  withTransaction,
  endSession: vi.fn(async () => undefined),
}))

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => ({ collection: () => stockCollection })),
  getMongoClient: vi.fn(async () => ({ startSession })),
}))

vi.mock('@/lib/models/Product', async () => {
  const actual = await vi.importActual<typeof import('@/lib/models/Product')>(
    '@/lib/models/Product'
  )
  return {
    ...actual,
    getStockCollection: vi.fn(() => stockCollection),
  }
})

const makeRequest = (body: unknown) =>
  new Request('http://localhost/api/stock/transfer', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }) as never

const validBody = {
  productId: PRODUCT_ID,
  quantity: 3,
  fromLocation: 'sheikhupura',
  toLocation: 'lahore',
}

beforeEach(() => {
  vi.clearAllMocks()
  updateCalls.length = 0
  failUpdateAt = null

  stockCollection.findOne.mockResolvedValue({
    _id: new ObjectId(),
    productId: new ObjectId(PRODUCT_ID),
    location: 'sheikhupura',
    quantity: 10,
  })
  stockCollection.find.mockReturnValue({
    toArray: async () => [
      { _id: new ObjectId(), productId: new ObjectId(PRODUCT_ID), location: 'sheikhupura', quantity: 7 },
      { _id: new ObjectId(), productId: new ObjectId(PRODUCT_ID), location: 'lahore', quantity: 3 },
    ],
  })

  stockCollection.updateOne.mockImplementation(
    async (filter: unknown, update: unknown, options: unknown) => {
      updateCalls.push({ filter, update, options })
      if (failUpdateAt !== null && updateCalls.length === failUpdateAt) {
        throw new Error('simulated write failure')
      }
      return { matchedCount: 1, modifiedCount: 1, upsertedId: null }
    }
  )

  withTransaction.mockImplementation(async (fn: (session: unknown) => Promise<void>) => {
    await fn({ id: 'session' })
  })
})

describe('POST /api/stock/transfer', () => {
  it('applies both legs inside one transaction', async () => {
    const { POST } = await import('@/app/api/stock/transfer/route')
    const res = await POST(makeRequest(validBody))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(withTransaction).toHaveBeenCalledTimes(1)
    expect(updateCalls).toHaveLength(2)

    // Both writes must carry the transaction session, or they escape it.
    for (const call of updateCalls) {
      expect((call.options as { session?: unknown }).session).toBeDefined()
    }

    // Source is decremented, destination incremented.
    expect((updateCalls[0].update as { $inc: { quantity: number } }).$inc.quantity).toBe(-3)
    expect((updateCalls[1].update as { $inc: { quantity: number } }).$inc.quantity).toBe(3)
  })

  it('decrements the source with a quantity guard so stock cannot go negative', async () => {
    const { POST } = await import('@/app/api/stock/transfer/route')
    await POST(makeRequest(validBody))

    const filter = updateCalls[0].filter as {
      productId: ObjectId
      location: string
      quantity: { $gte: number }
    }
    expect(filter.productId.toString()).toBe(PRODUCT_ID)
    expect(filter.location).toBe('sheikhupura')
    expect(filter.quantity.$gte).toBe(3)
  })

  it('aborts the transfer when the source was concurrently modified', async () => {
    const { POST } = await import('@/app/api/stock/transfer/route')
    // Guard matches nothing because someone else already moved the stock.
    stockCollection.updateOne.mockImplementationOnce(
      async (filter: unknown, update: unknown, options: unknown) => {
        updateCalls.push({ filter, update, options })
        return { matchedCount: 0, modifiedCount: 0, upsertedId: null }
      }
    )

    const res = await POST(makeRequest(validBody))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.success).toBe(false)
    expect(body.error.message).toMatch(/changed/i)
    // The destination must not have been written at all.
    expect(updateCalls).toHaveLength(1)
  })

  it('does not apply the destination leg when the source write fails', async () => {
    const { POST } = await import('@/app/api/stock/transfer/route')
    failUpdateAt = 1

    const res = await POST(makeRequest(validBody))

    expect(res.status).toBe(500)
    expect(updateCalls).toHaveLength(1)
    expect(stockCollection.find).not.toHaveBeenCalled()
  })

  it('rejects a transfer larger than the available stock before writing', async () => {
    const { POST } = await import('@/app/api/stock/transfer/route')
    stockCollection.findOne.mockResolvedValue({
      productId: new ObjectId(PRODUCT_ID),
      location: 'sheikhupura',
      quantity: 2,
    })

    const res = await POST(makeRequest({ ...validBody, quantity: 5 }))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.message).toMatch(/not enough stock/i)
    expect(updateCalls).toHaveLength(0)
    expect(startSession).not.toHaveBeenCalled()
  })

  it('validates the payload before any database access', async () => {
    const { POST } = await import('@/app/api/stock/transfer/route')
    const res = await POST(makeRequest({ ...validBody, quantity: -1 }))

    expect(res.status).toBe(400)
    expect(stockCollection.findOne).not.toHaveBeenCalled()
    expect(startSession).not.toHaveBeenCalled()
  })
})