import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'

const makeCollection = () => ({
  find: vi.fn(),
  findOne: vi.fn(),
  insertOne: vi.fn(),
  updateOne: vi.fn(),
  deleteOne: vi.fn(),
  countDocuments: vi.fn(),
  createIndex: vi.fn(),
  aggregate: vi.fn(() => ({ toArray: async () => [] })),
})

const incomeCollection = makeCollection()
const expenseCollection = makeCollection()
const transferCollection = makeCollection()
const transactionsCollection = makeCollection()
const accountsCollection = makeCollection()
const categoriesCollection = makeCollection()
const businessSettingsCollection = makeCollection()

const collections: Record<string, unknown> = {
  income: incomeCollection,
  expenses: expenseCollection,
  transfers: transferCollection,
  transactions: transactionsCollection,
  accounts: accountsCollection,
  financeCategories: categoriesCollection,
  businessSettings: businessSettingsCollection,
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

vi.mock('@/lib/models/Ledger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/models/Ledger')>('@/lib/models/Ledger')
  return {
    ...actual,
    ensureLedgerIndexes: vi.fn(async () => undefined),
  }
})

const makeRequest = (url: string, init?: RequestInit) => new Request(url, init) as never
const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.clearAllMocks()
  transactionsCollection.findOne.mockResolvedValue(null)
  transactionsCollection.insertOne.mockImplementation(async (doc: Record<string, unknown>) => ({
    insertedId: new ObjectId('507f1f77bcf86cd799439011'),
    ...doc,
  }))
  transactionsCollection.find.mockReturnValue({ sort: () => ({ toArray: async () => [] }), toArray: async () => [] })
  accountsCollection.findOne.mockResolvedValue({ _id: new ObjectId('507f1f77bcf86cd799439011'), isActive: true })
  accountsCollection.find.mockReturnValue({ toArray: async () => [{ _id: new ObjectId('507f1f77bcf86cd799439011'), name: 'Cash', kind: 'cash', openingBalance: 0, isActive: true, createdAt: new Date(), updatedAt: new Date() }], sort: () => ({ toArray: async () => [] }) })
  categoriesCollection.findOne.mockResolvedValue({ name: 'sales', type: 'income', isActive: true })
  categoriesCollection.find.mockReturnValue({ sort: () => ({ toArray: async () => [] }), toArray: async () => [] })
  businessSettingsCollection.findOne.mockResolvedValue(null)
})

describe('PUT/DELETE legacy finance routes', () => {
  it('rejects PUT with 405 (no silent edits)', async () => {
    const { PUT } = await import('@/app/api/finance/[type]/[id]/route')
    const res = await PUT(makeRequest('http://localhost/api/finance/income/507f1f77bcf86cd799439011', json({}))) as any
    expect(res.status).toBe(405)
  })

  it('rejects DELETE with 405 (no hard deletes)', async () => {
    const { DELETE } = await import('@/app/api/finance/[type]/[id]/route')
    const res = await DELETE(makeRequest('http://localhost/api/finance/expense/507f1f77bcf86cd799439011')) as any
    expect(res.status).toBe(405)
  })
})
