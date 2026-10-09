import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'

/**
 * Regression tests for the finance API routes.
 *
 * The original bug: `[type]/[id]` read the record type and id from the request
 * body / query string instead of the route params, so every edit and delete
 * failed validation and the UI silently lost writes. These tests pin the
 * route-param behaviour, the GET response shape the client depends on, and the
 * `clientRequestId` idempotency contract.
 */

/** Independent spies per collection — a shallow spread would share mocks. */
const makeCollection = () => ({
  find: vi.fn(),
  findOne: vi.fn(),
  insertOne: vi.fn(),
  updateOne: vi.fn(),
  deleteOne: vi.fn(),
  countDocuments: vi.fn(),
  createIndex: vi.fn(),
})

const incomeCollection = makeCollection()
const expenseCollection = makeCollection()
const transferCollection = makeCollection()

const collections: Record<string, unknown> = {
  income: incomeCollection,
  expenses: expenseCollection,
  transfers: transferCollection,
}

vi.mock('@/lib/mongodb', () => ({
  getDatabase: vi.fn(async () => ({ collection: (name: string) => collections[name] })),
}))

vi.mock('@/lib/models/Finance', async () => {
  const actual = await vi.importActual<typeof import('@/lib/models/Finance')>('@/lib/models/Finance')
  return {
    ...actual,
    ensureFinanceIndexes: vi.fn(async () => undefined),
  }
})

const makeRequest = (url: string, init?: RequestInit) => new Request(url, init) as never
const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })

const validIncome = {
  type: 'income',
  amount: 123400,
  category: 'sales',
  source: 'cod',
  description: 'test',
  date: '2026-10-01T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  incomeCollection.createIndex.mockResolvedValue('clientRequestId_1')
  expenseCollection.createIndex.mockResolvedValue('clientRequestId_1')
  transferCollection.createIndex.mockResolvedValue('clientRequestId_1')
  incomeCollection.countDocuments.mockResolvedValue(0)
  incomeCollection.insertOne.mockImplementation(async (doc: Record<string, unknown>) => ({
    insertedId: new ObjectId('507f1f77bcf86cd799439011'),
    ...doc,
  }))
  incomeCollection.findOne.mockResolvedValue(null)
  incomeCollection.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })
  incomeCollection.deleteOne.mockResolvedValue({ deletedCount: 1 })
})

describe('PUT /api/finance/[type]/[id]', () => {
  it('updates the record addressed by the route params, not the body', async () => {
    const { PUT } = await import('@/app/api/finance/[type]/[id]/route')
    const id = '507f1f77bcf86cd799439011'
    const params = Promise.resolve({ type: 'income', id })

    incomeCollection.findOne.mockResolvedValue({ _id: new ObjectId(id) })

    // PUT replaces the validated document, so the payload must be complete.
    const res = await PUT(
      makeRequest('http://localhost/api/finance/income/' + id, json({ ...validIncome, amount: 500 })),
      { params } as never
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data._id).toBe(id)

    // The filter must come from the route id, not from anything in the body.
    const [filter, update] = incomeCollection.updateOne.mock.calls[0]
    expect(filter._id.toString()).toBe(id)
    expect(update.$set.amount).toBe(500)
    expect(update.$set.updatedAt).toBeInstanceOf(Date)
  })

  it('routes to the expense collection when the path says expense', async () => {
    const { PUT } = await import('@/app/api/finance/[type]/[id]/route')
    const id = '507f1f77bcf86cd799439011'
    expenseCollection.findOne.mockResolvedValue({ _id: new ObjectId(id) })
    expenseCollection.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })

    const res = await PUT(
      makeRequest('http://localhost/api/finance/expense/' + id, json({ amount: 700, category: 'other', date: '2026-10-01T00:00:00.000Z' })),
      { params: Promise.resolve({ type: 'expense', id }) } as never
    )

    expect(res.status).toBe(200)
    expect(expenseCollection.updateOne).toHaveBeenCalledTimes(1)
    expect(incomeCollection.updateOne).not.toHaveBeenCalled()
  })

  it('rejects an unsupported type with 400 and never touches the database', async () => {
    const { PUT } = await import('@/app/api/finance/[type]/[id]/route')
    const res = await PUT(
      makeRequest('http://localhost/api/finance/bogus/507f1f77bcf86cd799439011', json({ amount: 1 })),
      { params: Promise.resolve({ type: 'bogus', id: '507f1f77bcf86cd799439011' }) } as never
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details[0].path).toBe('type')
    expect(incomeCollection.updateOne).not.toHaveBeenCalled()
  })

  it('rejects a malformed id with 400', async () => {
    const { PUT } = await import('@/app/api/finance/[type]/[id]/route')
    const res = await PUT(
      makeRequest('http://localhost/api/finance/income/not-an-id', json({ amount: 1 })),
      { params: Promise.resolve({ type: 'income', id: 'not-an-id' }) } as never
    )
    expect(res.status).toBe(400)
    expect(incomeCollection.updateOne).not.toHaveBeenCalled()
  })

  it('returns 404 when the record does not exist', async () => {
    const { PUT } = await import('@/app/api/finance/[type]/[id]/route')
    incomeCollection.findOne.mockResolvedValue(null)
    const res = await PUT(
      makeRequest('http://localhost/api/finance/income/507f1f77bcf86cd799439011', json({ amount: 1 })),
      { params: Promise.resolve({ type: 'income', id: '507f1f77bcf86cd799439011' }) } as never
    )
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/finance/[type]/[id]', () => {
  it('deletes using the route params', async () => {
    const { DELETE } = await import('@/app/api/finance/[type]/[id]/route')
    const id = '507f1f77bcf86cd799439011'
    const res = await DELETE(makeRequest('http://localhost/api/finance/income/' + id), {
      params: Promise.resolve({ type: 'income', id }),
    } as never)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data._id).toBe(id)
    expect(incomeCollection.deleteOne.mock.calls[0][0]._id.toString()).toBe(id)
  })

  it('returns 404 when nothing was deleted', async () => {
    const { DELETE } = await import('@/app/api/finance/[type]/[id]/route')
    incomeCollection.deleteOne.mockResolvedValue({ deletedCount: 0 })
    const res = await DELETE(makeRequest('http://localhost/api/finance/income/507f1f77bcf86cd799439011'), {
      params: Promise.resolve({ type: 'income', id: '507f1f77bcf86cd799439011' }),
    } as never)
    expect(res.status).toBe(404)
  })

  it('rejects a malformed id with 400', async () => {
    const { DELETE } = await import('@/app/api/finance/[type]/[id]/route')
    const res = await DELETE(makeRequest('http://localhost/api/finance/income/nope'), {
      params: Promise.resolve({ type: 'income', id: 'nope' }),
    } as never)
    expect(res.status).toBe(400)
    expect(incomeCollection.deleteOne).not.toHaveBeenCalled()
  })
})

describe('GET /api/finance', () => {
  const chain = (items: unknown[]) => ({
    sort: () => chain(items),
    skip: () => chain(items),
    limit: () => chain(items),
    toArray: async () => items,
  })

  it('returns income/expenses/transfers buckets with pagination', async () => {
    const { GET } = await import('@/app/api/finance/route')
    for (const col of [incomeCollection, expenseCollection, transferCollection]) {
      col.find.mockReturnValue(chain([]))
      col.countDocuments.mockResolvedValue(0)
    }

    const res = await GET(makeRequest('http://localhost/api/finance?type=all&limit=100'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    // Shape consumed by useFinanceData — must not be null for type=all.
    expect(body.data.income).not.toBeNull()
    expect(body.data.expenses).not.toBeNull()
    expect(body.data.transfers).not.toBeNull()
    expect(body.data.income.pagination).toMatchObject({ page: 1, limit: 100 })
  })

  it('omits buckets the caller did not ask for', async () => {
    const { GET } = await import('@/app/api/finance/route')
    incomeCollection.find.mockReturnValue(chain([]))
    incomeCollection.countDocuments.mockResolvedValue(0)

    const res = await GET(makeRequest('http://localhost/api/finance?type=income'))
    const body = await res.json()

    expect(body.data.income).not.toBeNull()
    expect(body.data.expenses).toBeNull()
    expect(body.data.transfers).toBeNull()
    expect(expenseCollection.find).not.toHaveBeenCalled()
  })

  it('clamps limit and rejects an unparseable date filter', async () => {
    const { GET } = await import('@/app/api/finance/route')
    incomeCollection.find.mockReturnValue(chain([]))
    incomeCollection.countDocuments.mockResolvedValue(0)

    const clamped = await (await GET(makeRequest('http://localhost/api/finance?type=income&limit=99999'))).json()
    expect(clamped.data.income.pagination.limit).toBe(200)

    const bad = await GET(makeRequest('http://localhost/api/finance?startDate=not-a-date'))
    expect(bad.status).toBe(400)
  })
})

describe('POST /api/finance idempotency', () => {
  it('stores the clientRequestId so a replay can be recognised', async () => {
    const { POST } = await import('@/app/api/finance/route')
    const res = await POST(makeRequest('http://localhost/api/finance', json({ ...validIncome, clientRequestId: 'req-1' })))
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.success).toBe(true)
    expect(incomeCollection.insertOne.mock.calls[0][0].clientRequestId).toBe('req-1')
    expect(body.data.amount).toBe(123400)
  })

  it('returns the existing record instead of writing a duplicate', async () => {
    const { POST } = await import('@/app/api/finance/route')
    incomeCollection.findOne.mockResolvedValue({
      _id: new ObjectId('507f1f77bcf86cd799439011'),
      incomeNumber: 'INC-00001',
      amount: 123400,
      category: 'sales',
      source: 'cod',
      date: new Date('2026-10-01'),
      createdAt: new Date(),
    })

    const res = await POST(makeRequest('http://localhost/api/finance', json({ ...validIncome, clientRequestId: 'req-1' })))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(incomeCollection.insertOne).not.toHaveBeenCalled()
    expect(body.data._id).toBe('507f1f77bcf86cd799439011')
    expect(body.data.incomeNumber).toBe('INC-00001')
  })

  it('resolves a lost idempotency race instead of surfacing a duplicate-key error', async () => {
    const { POST } = await import('@/app/api/finance/route')
    const duplicateKey = Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
    incomeCollection.insertOne.mockRejectedValueOnce(duplicateKey)
    incomeCollection.findOne.mockResolvedValue({
      _id: new ObjectId('507f1f77bcf86cd799439011'),
      incomeNumber: 'INC-00001',
      amount: 123400,
      category: 'sales',
      source: 'cod',
      date: new Date('2026-10-01'),
      createdAt: new Date(),
    })

    const res = await POST(makeRequest('http://localhost/api/finance', json({ ...validIncome, clientRequestId: 'req-1' })))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data._id).toBe('507f1f77bcf86cd799439011')
  })

  it('rejects an unsupported type before any database call', async () => {
    const { POST } = await import('@/app/api/finance/route')
    const { getDatabase } = await import('@/lib/mongodb')
    vi.mocked(getDatabase).mockClear()

    const res = await POST(makeRequest('http://localhost/api/finance', json({ type: 'bogus' })))

    expect(res.status).toBe(400)
    expect(getDatabase).not.toHaveBeenCalled()
  })

  it('reports per-field validation problems', async () => {
    const { POST } = await import('@/app/api/finance/route')
    const res = await POST(makeRequest('http://localhost/api/finance', json({ type: 'income', amount: -1 })))
    const body = await res.json()

    expect(res.status).toBe(400)
    const paths = body.error.details.map((d: { path: string }) => d.path)
    expect(paths).toContain('amount')
    expect(paths).toContain('category')
  })
})