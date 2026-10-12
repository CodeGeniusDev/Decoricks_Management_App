import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { authorizeStockWrite } from '@/lib/authorization'

/**
 * Tests for POST /api/stock/transfer.
 *
 * Phase 5 turned a transfer into a `transfer` MOVEMENT on the append-only
 * ledger instead of a raw pair of `$inc`s. The invariants that matter:
 *   • the movement and the projection legs still share ONE transaction, so a
 *     failed leg can never destroy or duplicate units;
 *   • a transfer needs authority over BOTH locations (SPEC §4.2);
 *   • a replayed idempotency key must not move stock twice;
 *   • a transfer is neither a purchase nor a sale — it touches no money.
 * The guarded-decrement / rollback behaviour of the movement itself is pinned
 * in stock-service.test.ts against the real writer.
 */

const PRODUCT_ID = '507f1f77bcf86cd799439011'
const MOVEMENT_ID = '507f1f77bcf86cd799439022'

const stockCollection = {
  find: vi.fn(),
  findOne: vi.fn(),
  updateOne: vi.fn(),
  insertOne: vi.fn(),
  createIndex: vi.fn(),
}

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => ({ collection: () => stockCollection })),
  getMongoClient: vi.fn(async () => ({
    startSession: vi.fn(() => ({
      withTransaction: vi.fn(async (fn: (s: unknown) => Promise<void>) => fn({ id: 'session' })),
      endSession: vi.fn(async () => undefined),
    })),
  })),
}))

vi.mock('@/lib/models/Product', async () => {
  const actual = await vi.importActual<typeof import('@/lib/models/Product')>(
    '@/lib/models/Product'
  )
  return { ...actual, getStockCollection: vi.fn(() => stockCollection) }
})

vi.mock('@/lib/models/Inventory', async () => {
  const actual = await vi.importActual<typeof import('@/lib/models/Inventory')>(
    '@/lib/models/Inventory'
  )
  return { ...actual, ensureInventoryIndexes: vi.fn(async () => undefined) }
})

// Captures what the route asked the stock service to write.
const runInTransaction = vi.fn(async (fn: (session: unknown) => Promise<unknown>) =>
  fn({ id: 'tx-session' })
)
const postMovement = vi.fn(
  async (
    _db: unknown,
    _input: Record<string, unknown>,
    _session?: unknown
  ): Promise<{ movement: { _id: ObjectId }; created: boolean }> => ({
    movement: { _id: new ObjectId(MOVEMENT_ID) },
    created: true,
  })
)
const getAllowNegativeStock = vi.fn(async () => false)

vi.mock('@/lib/stock-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/stock-service')>(
    '@/lib/stock-service'
  )
  return { ...actual, runInTransaction, postMovement, getAllowNegativeStock }
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
  idempotencyKey: 'transfer-abc',
}

beforeEach(() => {
  vi.clearAllMocks()

  stockCollection.find.mockReturnValue({
    toArray: async () => [
      { _id: new ObjectId(), productId: new ObjectId(PRODUCT_ID), location: 'sheikhupura', quantity: 7 },
      { _id: new ObjectId(), productId: new ObjectId(PRODUCT_ID), location: 'lahore', quantity: 3 },
    ],
  })
  stockCollection.findOne.mockResolvedValue(null)
  stockCollection.updateOne.mockResolvedValue({ acknowledged: true })
  stockCollection.insertOne.mockResolvedValue({ insertedId: new ObjectId() })

  runInTransaction.mockImplementation(async (fn: (session: unknown) => Promise<unknown>) =>
    fn({ id: 'tx-session' })
  )
  postMovement.mockImplementation(
    async (_db: unknown, _input: Record<string, unknown>, _session?: unknown) => ({
      movement: { _id: new ObjectId(MOVEMENT_ID) },
      created: true,
    })
  )
  getAllowNegativeStock.mockResolvedValue(false)
  vi.mocked(authorizeStockWrite).mockResolvedValue(undefined as never)
})

describe('POST /api/stock/transfer', () => {
  it('writes one transfer movement covering both locations, inside the transaction', async () => {
    const { POST } = await import('@/app/api/stock/transfer/route')
    const res = await POST(makeRequest(validBody))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.replay).toBe(false)

    expect(runInTransaction).toHaveBeenCalledTimes(1)
    expect(postMovement).toHaveBeenCalledTimes(1)

    const input = postMovement.mock.calls[0][1]
    expect(input.movementType).toBe('transfer')
    expect(input.quantity).toBe(3)
    expect(input.fromLocation).toBe('sheikhupura')
    expect(input.toLocation).toBe('lahore')
    expect(String(input.productId)).toBe(PRODUCT_ID)
    expect(input.idempotencyKey).toBe('transfer-abc')
    // The caller's session must be threaded through, or the movement escapes
    // the transaction and a failure would leave the projection moved anyway.
    expect(postMovement.mock.calls[0][2]).toEqual({ id: 'tx-session' })
  })

  it('needs authority over both the source and the destination location', async () => {
    const { POST } = await import('@/app/api/stock/transfer/route')
    await POST(makeRequest(validBody))

    expect(authorizeStockWrite).toHaveBeenCalledTimes(1)
    expect(vi.mocked(authorizeStockWrite).mock.calls[0][0]).toEqual(['sheikhupura', 'lahore'])
  })

  it('never touches the money ledger — a transfer is neither a purchase nor a sale', async () => {
    const { POST } = await import('@/app/api/stock/transfer/route')
    await POST(makeRequest(validBody))

    const input = postMovement.mock.calls[0][1]
    expect(input.unitCost).toBeUndefined()
    // The only writes performed are the movement plus the projection reads.
    expect(stockCollection.updateOne).not.toHaveBeenCalled()
  })

  it('reports a replay without a second audit entry when the key already exists', async () => {
    postMovement.mockImplementation(
      async (_db: unknown, _input: Record<string, unknown>, _session?: unknown) => ({
        movement: { _id: new ObjectId(MOVEMENT_ID) },
        created: false,
      })
    )

    const { POST } = await import('@/app/api/stock/transfer/route')
    const res = await POST(makeRequest(validBody))

    expect(res.status).toBe(200)
    expect((await res.json()).data.replay).toBe(true)
    // No movement was newly created, so nothing is audited a second time.
    expect(stockCollection.insertOne).not.toHaveBeenCalled()
  })

  it('carries the Founder negative-stock gate into the movement', async () => {
    getAllowNegativeStock.mockResolvedValue(true)

    const { POST } = await import('@/app/api/stock/transfer/route')
    await POST(makeRequest(validBody))

    expect(getAllowNegativeStock).toHaveBeenCalledTimes(1)
    expect(postMovement.mock.calls[0][1].allowNegative).toBe(true)
  })

  it('validates the payload before any database access', async () => {
    const { POST } = await import('@/app/api/stock/transfer/route')
    const res = await POST(makeRequest({ ...validBody, quantity: -1 }))

    expect(res.status).toBe(400)
    expect(postMovement).not.toHaveBeenCalled()
    expect(runInTransaction).not.toHaveBeenCalled()
  })

  it('refuses to move the same product to itself', async () => {
    const { POST } = await import('@/app/api/stock/transfer/route')
    const res = await POST(
      makeRequest({ ...validBody, fromLocation: 'lahore', toLocation: 'lahore' })
    )

    expect(res.status).toBe(400)
    expect(postMovement).not.toHaveBeenCalled()
  })
})
