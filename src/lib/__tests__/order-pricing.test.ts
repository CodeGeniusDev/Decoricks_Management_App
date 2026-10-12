import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'

/**
 * Regression tests for server-side order pricing.
 *
 * The original bug: order lines took `productName` and `unitPrice` straight from
 * the request body, so a stale or tampered client could record a sale under an
 * invented product name and an arbitrary price. Prices and names must be
 * rebuilt from the products collection.
 *
 * Phase 5 adds the second half of the flow: creating an order is also a stock
 * reservation, so every priced line must post a `sale_out` movement carrying
 * the product's weighted-average cost as its COGS snapshot.
 */

const KNOWN_ID = '507f1f77bcf86cd799439011'
const INACTIVE_ID = '507f1f77bcf86cd799439012'

const productCollection = {
  find: vi.fn(),
  insertOne: vi.fn(),
  createIndex: vi.fn(),
}

const orderCollection = {
  find: vi.fn(),
  findOne: vi.fn(),
  insertOne: vi.fn(),
  updateOne: vi.fn(),
  createIndex: vi.fn(),
}

const auditCollection = {
  insertOne: vi.fn(async (_doc: Record<string, unknown>) => ({ insertedId: new ObjectId(KNOWN_ID) })),
  insertMany: vi.fn(),
}

// Order numbers come from an atomic counter document (`lib/serial`). These
// tests are about pricing, so the counter only has to hand out a fresh value.
let counterSeq = 0
const countersCollection = {
  findOne: vi.fn(async () => ({ _id: 'orderNumber:SO', base: 0, seq: counterSeq })),
  updateOne: vi.fn(async () => ({ acknowledged: true })),
  findOneAndUpdate: vi.fn(async () => ({ base: 0, seq: ++counterSeq })),
}

const collections: Record<string, unknown> = {
  products: productCollection,
  orders: orderCollection,
  auditLog: auditCollection,
  counters: countersCollection,
}

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => ({ collection: (name: string) => collections[name] })),
}))

vi.mock('@/lib/models/Sales', async () => {
  const actual = await vi.importActual<typeof import('@/lib/models/Sales')>(
    '@/lib/models/Sales'
  )
  return {
    ...actual,
    getOrderCollection: vi.fn(() => orderCollection),
    ensureOrdersIndexes: vi.fn(async () => undefined),
  }
})

vi.mock('@/lib/models/Product', async () => {
  const actual = await vi.importActual<typeof import('@/lib/models/Product')>(
    '@/lib/models/Product'
  )
  return { ...actual, getProductCollection: vi.fn(() => productCollection) }
})

// Index creation needs a real (replica-set) connection; irrelevant here.
vi.mock('@/lib/models/Inventory', async () => {
  const actual = await vi.importActual<typeof import('@/lib/models/Inventory')>(
    '@/lib/models/Inventory'
  )
  return { ...actual, ensureInventoryIndexes: vi.fn(async () => undefined) }
})

// The stock service is the transactional boundary. These stubs keep the route
// under test while capturing exactly what was reserved.
const runInTransaction = vi.fn(async (fn: (session: unknown) => Promise<unknown>) =>
  fn({ id: 'session' })
)
const postMovement = vi.fn(
  async (
    _db: unknown,
    _input: Record<string, unknown>,
    _session?: unknown
  ): Promise<{ movement: { _id: ObjectId }; created: boolean }> => ({
    movement: { _id: new ObjectId(KNOWN_ID) },
    created: true,
  })
)
const getAllowNegativeStock = vi.fn(async () => false)

vi.mock('@/lib/stock-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/stock-service')>(
    '@/lib/stock-service'
  )
  return {
    ...actual,
    runInTransaction,
    postMovement,
    getAllowNegativeStock,
  }
})

const product = (id: string, name: string, sellingPrice: number, isActive = true) => ({
  _id: new ObjectId(id),
  sku: name.toUpperCase(),
  name,
  category: 'decor',
  cost: 100,
  sellingPrice,
  isActive,
  createdAt: new Date(),
  updatedAt: new Date(),
})

const post = (items: unknown[]) =>
  new Request('http://localhost/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      customerName: 'Customer',
      customerPhone: '03001234567',
      customerCity: 'Lahore',
      customerAddress: 'Somewhere',
      salesChannel: 'website',
      // Phase 5: an order ships from exactly one location and reserves there.
      shipFromLocation: 'lahore',
      items,
    }),
    headers: { 'Content-Type': 'application/json' },
  }) as never

beforeEach(() => {
  vi.clearAllMocks()
  orderCollection.createIndex.mockResolvedValue('orderNumber_1')
  orderCollection.findOne.mockResolvedValue(null)
  orderCollection.updateOne.mockResolvedValue({ acknowledged: true })
  // Any read-many walk on orders (the counter seeds itself from `counters`).
  orderCollection.find.mockReturnValue({
    sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
  })
  orderCollection.insertOne.mockImplementation(async (doc: Record<string, unknown>) => ({
    insertedId: new ObjectId('507f1f77bcf86cd799439099'),
    ...doc,
  }))
  productCollection.find.mockReturnValue({
    toArray: async () => [product(KNOWN_ID, 'Real Vase', 250000)],
  })
  runInTransaction.mockImplementation(async (fn: (session: unknown) => Promise<unknown>) =>
    fn({ id: 'session' })
  )
  postMovement.mockImplementation(
    async (_db: unknown, _input: Record<string, unknown>, _session?: unknown) => ({
      movement: { _id: new ObjectId(KNOWN_ID) },
      created: true,
    })
  )
  getAllowNegativeStock.mockResolvedValue(false)
})

describe('POST /api/orders pricing', () => {
  it('ignores the client name and price and uses the stored product', async () => {
    const { POST } = await import('@/app/api/orders/route')
    const res = await POST(
      post([{ productId: KNOWN_ID, quantity: 2, productName: 'Fake', unitPrice: 1, total: 2 }])
    )
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.success).toBe(true)

    const inserted = orderCollection.insertOne.mock.calls[0][0] as {
      items: Array<{ productName: string; unitPrice: number; total: number }>
      subtotal: number
      total: number
    }

    expect(inserted.items[0].productName).toBe('Real Vase')
    expect(inserted.items[0].unitPrice).toBe(250000)
    expect(inserted.items[0].total).toBe(500000)
    expect(inserted.subtotal).toBe(500000)
    expect(inserted.total).toBe(500000)

    // SPEC §10.2.6 Test 16: a successful create must leave an audit entry.
    expect(auditCollection.insertOne).toHaveBeenCalledTimes(1)
    const audit = auditCollection.insertOne.mock.calls[0][0] as { action: string; entityType: string }
    expect(audit.action).toBe('order_created')
    expect(audit.entityType).toBe('order')
  })

  it('rejects an order without a ship-from location', async () => {
    const { POST } = await import('@/app/api/orders/route')
    const res = await POST(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          customerName: 'Customer',
          customerPhone: '03001234567',
          customerCity: 'Lahore',
          customerAddress: 'Somewhere',
          salesChannel: 'website',
          items: [{ productId: KNOWN_ID, quantity: 1 }],
        }),
        headers: { 'Content-Type': 'application/json' },
      }) as never
    )
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toMatch(/shipFromLocation/)
    expect(orderCollection.insertOne).not.toHaveBeenCalled()
  })

  it('rejects a line whose product does not exist', async () => {
    const { POST } = await import('@/app/api/orders/route')
    const res = await POST(post([{ productId: INACTIVE_ID, quantity: 1 }]))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.message).toMatch(/unknown product/i)
    expect(orderCollection.insertOne).not.toHaveBeenCalled()
  })

  it('rejects an inactive product rather than selling it', async () => {
    productCollection.find.mockReturnValue({
      toArray: async () => [product(INACTIVE_ID, 'Retired Item', 900, false)],
    })

    const { POST } = await import('@/app/api/orders/route')
    const res = await POST(post([{ productId: INACTIVE_ID, quantity: 1 }]))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.message).toMatch(/unavailable/i)
    expect(JSON.stringify(body.error.details)).toMatch(/not active/i)
    expect(orderCollection.insertOne).not.toHaveBeenCalled()
  })

  it('recomputes totals from priced lines rather than the submitted total', async () => {
    const { POST } = await import('@/app/api/orders/route')
    await POST(post([{ productId: KNOWN_ID, quantity: 3, productName: 'Fake', unitPrice: 1, total: 999999 }]))

    const inserted = orderCollection.insertOne.mock.calls[0][0] as { total: number }
    expect(inserted.total).toBe(750000)
  })

  it('reserves the sold quantity as a sale_out movement carrying the product cost', async () => {
    const { POST } = await import('@/app/api/orders/route')
    const res = await POST(post([{ productId: KNOWN_ID, quantity: 2 }]))
    expect(res.status).toBe(201)

    expect(postMovement).toHaveBeenCalledTimes(1)
    const args = postMovement.mock.calls[0][1] as Record<string, unknown>
    expect(args.movementType).toBe('sale_out')
    expect(args.quantity).toBe(2)
    expect(args.fromLocation).toBe('lahore')
    expect(args.unitCost).toBe(100) // WAC snapshot → the COGS basis
    expect(args.referenceType).toBe('order')
    expect(String(args.idempotencyKey)).toMatch(/:out:0$/)

    // The reservation must be remembered on the order so a cancel can reverse it.
    const update = orderCollection.updateOne.mock.calls[0][1] as {
      $set: { items: Array<{ unitCost?: number }>; stockMovementIds: unknown[] }
    }
    expect(update.$set.stockMovementIds).toHaveLength(1)
    expect(update.$set.items[0].unitCost).toBe(100)
  })

  it('posts nothing when the order is rejected, so no phantom reservation survives', async () => {
    productCollection.find.mockReturnValue({ toArray: async () => [] })

    const { POST } = await import('@/app/api/orders/route')
    const res = await POST(post([{ productId: INACTIVE_ID, quantity: 1 }]))
    expect(res.status).toBe(400)
    expect(postMovement).not.toHaveBeenCalled()
    expect(orderCollection.insertOne).not.toHaveBeenCalled()
  })
})
