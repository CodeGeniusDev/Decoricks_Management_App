import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'

/**
 * Regression tests for server-side order pricing.
 *
 * The original bug: order lines took `productName` and `unitPrice` straight from
 * the request body, so a stale or tampered client could record a sale under an
 * invented product name and an arbitrary price. Prices and names must be
 * rebuilt from the products collection.
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

const collections: Record<string, unknown> = {
  products: productCollection,
  orders: orderCollection,
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
      items,
    }),
    headers: { 'Content-Type': 'application/json' },
  }) as never

beforeEach(() => {
  vi.clearAllMocks()
  orderCollection.createIndex.mockResolvedValue('orderNumber_1')
  orderCollection.findOne.mockResolvedValue(null)
  // nextOrderNumber walks find().sort().limit().toArray()
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
})