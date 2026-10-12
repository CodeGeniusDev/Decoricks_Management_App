/**
 * Phase 5 API + reconciliation tests.
 *
 * These run the REAL route handlers against `helpers/mem-mongo`, an in-memory
 * stand-in that keeps the two properties the Phase 5 guarantees actually rest on:
 * a unique index on `idempotencyKey` (error code 11000) and per-document atomic
 * read-modify-write, so a guarded `$inc` is evaluated at apply time. Transactions
 * go through `runInTransaction` → `client.startSession()` → `withTransaction`,
 * so a failed write really rolls back.
 *
 * `@/lib/authorization` is mocked permissively by src/test/setup.ts (a Founder);
 * every denial test overrides the next call with the real error classes so
 * `handleRouteError` maps the production 401/403 statuses.
 *
 * Covers the brief's TESTS section: validation, duplicate idempotency key,
 * concurrent sales of the last unit, negative stock blocked, 401/403 on every
 * Phase 5 route, a Partner without permission cannot write, and the full
 * purchase → transfer → sale → deliver → return → damage reconciliation.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { ObjectId } from 'mongodb'
import {
  authorize,
  authorizeAllViews,
  authorizeScoped,
  authorizeStockWrite,
  requireAuth,
  requireFounder,
  AuthenticationError,
  AuthorizationError,
} from '@/lib/authorization'
import { getKarachiDate } from '@/lib/date'
import { createMemDb, type MemDb, type Doc } from './helpers/mem-mongo'
import { deriveStock, cogsFromMovements, type MovementLike } from '@/lib/stock-math'

/* ------------------------------- wiring ---------------------------------- */

let mem: MemDb

vi.mock('@/lib/mongodb', () => ({
  // The factory body only builds closures, so `mem` is read at call time and
  // never hits the temporal dead zone during module loading.
  getDatabase: vi.fn(async () => mem.handle),
  getMongoClient: vi.fn(async () => mem.client),
  withMongoRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

const CASH_ID = new ObjectId('507f1f77bcf86cd799439011')
const PRODUCT_ID = new ObjectId('507f1f77bcf86cd799439022')
const SUPPLIER_ID = new ObjectId('507f1f77bcf86cd799439033')
const MOVEMENT_ID = new ObjectId('507f1f77bcf86cd799439044')
const PURCHASE_ID = new ObjectId('507f1f77bcf86cd799439055')
const ACTOR_ID = new ObjectId('507f1f77bcf86cd7994390aa')

const cols = {
  products: () => mem.collection('products'),
  stock: () => mem.collection('stock'),
  movements: () => mem.collection('stockMovements'),
  orders: () => mem.collection('orders'),
  purchases: () => mem.collection('purchases'),
  returns: () => mem.collection('returns'),
  ledger: () => mem.collection('transactions'),
  suppliers: () => mem.collection('suppliers'),
  audit: () => mem.collection('auditLog'),
  settings: () => mem.collection('businessSettings'),
}

/** Today, as the app dates a posting: Karachi civil midnight in UTC. */
const KARACHI_TODAY = getKarachiDate()
const TODAY_ISO = KARACHI_TODAY.toISOString().slice(0, 10)

const seedBase = () => {
  mem.collection('accounts').push({
    _id: CASH_ID,
    name: 'Cash',
    kind: 'cash',
    openingBalance: 0,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  for (const [name, type] of [
    ['product_purchasing', 'expense'],
    ['shipping_courier', 'expense'],
    ['refunds_return_costs', 'expense'],
    ['sales_revenue', 'income'],
  ] as const) {
    mem.collection('financeCategories').push({ _id: new ObjectId(), name, type, isActive: true })
  }
  mem.collection('businessSettings').push({
    key: 'business',
    profitSharing: {
      partners: [
        { name: 'Abdullah', percentage: 20, reinvestPercentage: 100 },
        { name: 'Hasnat', percentage: 20, reinvestPercentage: 50 },
        { name: 'Ali', percentage: 20, reinvestPercentage: 100 },
        { name: 'Afnan', percentage: 20, reinvestPercentage: 0 },
      ],
      charityPercentage: 20,
    },
    budgetThresholds: { warning: 80, critical: 100 },
    createdAt: KARACHI_TODAY,
    updatedAt: KARACHI_TODAY,
  })
  mem.collection('products').push({
    _id: PRODUCT_ID,
    sku: 'SKU-SEED-1',
    name: 'Seed Cushion',
    category: 'cushion',
    cost: 50_000,
    sellingPrice: 120_000,
    reorderLevel: 2,
    variants: [],
    isActive: true,
    createdAt: KARACHI_TODAY,
    updatedAt: KARACHI_TODAY,
  })
  mem.collection('suppliers').push({
    _id: SUPPLIER_ID,
    name: 'Seed Supplier',
    city: 'Lahore',
    productsSupplied: ['cushion'],
    isActive: true,
    createdAt: KARACHI_TODAY,
    updatedAt: KARACHI_TODAY,
  })
  // A posted purchase_in and its purchase row, so the detail routes that look
  // a record up before authorizing have something to find.
  mem.collection('stockMovements').push({
    _id: MOVEMENT_ID,
    productId: PRODUCT_ID,
    movementType: 'purchase_in',
    quantity: 5,
    fromLocation: null,
    toLocation: 'sheikhupura',
    unitCost: 50_000,
    referenceId: PURCHASE_ID,
    referenceType: 'purchase',
    isReversal: false,
    status: 'posted',
    date: KARACHI_TODAY,
    createdAt: KARACHI_TODAY,
    createdBy: ACTOR_ID,
  })
  mem.collection('stock').push({
    _id: new ObjectId(),
    productId: PRODUCT_ID,
    location: 'sheikhupura',
    quantity: 5,
    lastUpdated: KARACHI_TODAY,
    updatedAt: KARACHI_TODAY,
  })
  mem.collection('purchases').push({
    _id: PURCHASE_ID,
    purchaseNumber: 'PUR-SEED-0001',
    supplierId: SUPPLIER_ID,
    supplierName: 'Seed Supplier',
    productId: PRODUCT_ID,
    productName: 'Seed Cushion',
    location: 'sheikhupura',
    quantity: 5,
    unitCost: 50_000,
    totalCost: 250_000,
    movementId: MOVEMENT_ID,
    date: KARACHI_TODAY,
    createdAt: KARACHI_TODAY,
    createdBy: ACTOR_ID,
  })
}

/**
 * The permissive Founder context, identical in shape to the one
 * `src/test/setup.ts` installs. Vitest 2's `mockReset()` clears queued
 * once-behaviour *and* the implementation, so the suite re-arms its own
 * defaults in `beforeEach` — that is what makes a leftover rejection from one
 * test impossible to poison the next.
 */
const founderCtx = () => ({
  user: {
    _id: new ObjectId('507f1f77bcf86cd799439011'),
    email: 'founder@decoricks.com',
    name: 'Test Founder',
    role: 'founder',
    isActive: true,
    mustChangePassword: false,
    sessionVersion: 1,
  },
  session: {
    tokenHash: 'test-token-hash',
    sessionVersion: 1,
    csrfToken: 'test-csrf-token',
    role: 'founder',
  },
  role: {
    name: 'founder',
    displayName: 'Founder',
    permissions: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  permissions: {},
})

const resetTo = (fn: unknown, impl: (...args: unknown[]) => Promise<unknown>) => {
  ;(fn as Mock).mockReset().mockImplementation(impl)
}

beforeEach(() => {
  resetTo(authorize, async () => founderCtx())
  resetTo(authorizeScoped, async () => founderCtx())
  resetTo(authorizeAllViews, async () => founderCtx())
  resetTo(requireAuth, async () => founderCtx())
  resetTo(requireFounder, async () => founderCtx())
  resetTo(authorizeStockWrite, async () => undefined)

  mem = createMemDb()
  seedBase()
})

/* ------------------------------- utilities -------------------------------- */

const makeRequest = (url: string, init?: RequestInit) => new Request(url, init) as never
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never
const invoke = (handler: unknown, ...args: unknown[]): Promise<Response> =>
  (handler as (...a: unknown[]) => Promise<Response>)(...args)

const P = (pkr: number) => Math.round(pkr * 100)
let keySeq = 0
const freshKey = (prefix = 'p5') => `${prefix}-key-${++keySeq}`

const stockQty = (productId: string, location: string): number =>
  cols.stock().docs.find(
    (d) => String(d.productId) === productId && d.location === location
  )?.quantity as number | undefined ?? 0

const ledgerByCategory = (category: string) =>
  cols
    .ledger()
    .docs.filter((d) => d.category === category)
    .map((d) => d as Doc & { type: string; amount: number })

const sum = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0)

/* ------------------------------ route modules ----------------------------- */

import * as productsRoute from '@/app/api/products/route'
import * as productDetailRoute from '@/app/api/products/[id]/route'
import * as stockRoute from '@/app/api/stock/route'
import * as movementsRoute from '@/app/api/stock/movements/route'
import * as reverseMovementRoute from '@/app/api/stock/movements/[id]/reverse/route'
import * as transferRoute from '@/app/api/stock/transfer/route'
import * as damageRoute from '@/app/api/stock/damage/route'
import * as summaryRoute from '@/app/api/stock/summary/route'
import * as purchasesRoute from '@/app/api/purchases/route'
import * as purchaseCancelRoute from '@/app/api/purchases/[id]/cancel/route'
import * as ordersRoute from '@/app/api/orders/route'
import * as orderDetailRoute from '@/app/api/orders/[id]/route'
import * as returnsRoute from '@/app/api/returns/route'
import * as returnDetailRoute from '@/app/api/returns/[id]/route'
import * as suppliersRoute from '@/app/api/suppliers/route'
import * as supplierDetailRoute from '@/app/api/suppliers/[id]/route'
import * as plRoute from '@/app/api/finance/pl/route'

/* ---------------------------- request bodies ----------------------------- */

const productBody = (overrides: Record<string, unknown> = {}) => ({
  sku: 'SKU-NEW-1',
  name: 'Macrame Wall Hanging',
  category: 'wall decor',
  cost: 5_000,
  sellingPrice: 12_000,
  reorderLevel: 3,
  ...overrides,
})

const purchaseBody = (overrides: Record<string, unknown> = {}) => ({
  productId: PRODUCT_ID.toString(),
  location: 'sheikhupura',
  quantity: 4,
  unitCost: 6_000,
  ...overrides,
})

const orderBody = (overrides: Record<string, unknown> = {}) => ({
  customerName: 'Ayesha Khan',
  customerPhone: '0300-1234567',
  customerCity: 'Lahore',
  customerAddress: 'House 4, Street 9, DHA',
  items: [{ productId: PRODUCT_ID.toString(), quantity: 1 }],
  salesChannel: 'instagram',
  shipFromLocation: 'sheikhupura',
  ...overrides,
})

const transferBody = (overrides: Record<string, unknown> = {}) => ({
  productId: PRODUCT_ID.toString(),
  quantity: 2,
  fromLocation: 'sheikhupura',
  toLocation: 'lahore',
  ...overrides,
})

/* -------------------------------------------------------------------------- */
/*  401 / 403 on every Phase 5 route                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every Phase 5 handler and a call that reaches its authorization gate. Bodies
 * are valid so a 400 can never masquerade as a pass, and ids exist in the seed
 * because a couple of routes look the record up before authorizing.
 */
const ALL_PHASE5_ROUTES: Array<{ name: string; call: () => Promise<Response> }> = [
  { name: 'GET /api/products', call: () => invoke(productsRoute.GET, makeRequest('http://localhost/api/products')) },
  {
    name: 'POST /api/products',
    call: () => invoke(productsRoute.POST, makeRequest('http://localhost/api/products', json(productBody()))),
  },
  {
    name: 'GET /api/products/[id]',
    call: () =>
      invoke(productDetailRoute.GET, makeRequest(`http://localhost/api/products/${PRODUCT_ID}`), ctx(PRODUCT_ID.toString())),
  },
  {
    name: 'PUT /api/products/[id]',
    call: () =>
      invoke(
        productDetailRoute.PUT,
        makeRequest('http://localhost/api/products/x', json({ name: 'Renamed' })),
        ctx(PRODUCT_ID.toString())
      ),
  },
  {
    name: 'DELETE /api/products/[id]',
    call: () =>
      invoke(productDetailRoute.DELETE, makeRequest('http://localhost/api/products/x', { method: 'DELETE' }), ctx(PRODUCT_ID.toString())),
  },
  { name: 'GET /api/stock', call: () => invoke(stockRoute.GET, makeRequest('http://localhost/api/stock')) },
  {
    name: 'POST /api/stock (count adjustment)',
    call: () =>
      invoke(
        stockRoute.POST,
        makeRequest('http://localhost/api/stock', json({ productId: PRODUCT_ID.toString(), location: 'sheikhupura', countedQuantity: 7, reason: 'Physical count' }))
      ),
  },
  {
    name: 'GET /api/stock/movements',
    call: () => invoke(movementsRoute.GET, makeRequest('http://localhost/api/stock/movements')),
  },
  {
    name: 'POST /api/stock/movements/[id]/reverse',
    call: () =>
      invoke(
        reverseMovementRoute.POST,
        makeRequest('http://localhost/api/stock/movements/x/reverse', json({ reason: 'Posted the wrong quantity' })),
        ctx(MOVEMENT_ID.toString())
      ),
  },
  {
    name: 'POST /api/stock/transfer',
    call: () => invoke(transferRoute.POST, makeRequest('http://localhost/api/stock/transfer', json(transferBody()))),
  },
  {
    name: 'POST /api/stock/damage',
    call: () =>
      invoke(
        damageRoute.POST,
        makeRequest('http://localhost/api/stock/damage', json({ productId: PRODUCT_ID.toString(), location: 'sheikhupura', quantity: 1, type: 'damage', reason: 'Water damage in storage' }))
      ),
  },
  {
    name: 'GET /api/stock/summary',
    call: () => invoke(summaryRoute.GET, makeRequest('http://localhost/api/stock/summary')),
  },
  { name: 'GET /api/purchases', call: () => invoke(purchasesRoute.GET, makeRequest('http://localhost/api/purchases')) },
  {
    name: 'POST /api/purchases',
    call: () => invoke(purchasesRoute.POST, makeRequest('http://localhost/api/purchases', json(purchaseBody()))),
  },
  {
    name: 'POST /api/purchases/[id]/cancel',
    call: () =>
      invoke(
        purchaseCancelRoute.POST,
        makeRequest('http://localhost/api/purchases/x/cancel', json({ reason: 'Order cancelled by supplier' })),
        ctx(PURCHASE_ID.toString())
      ),
  },
  { name: 'GET /api/orders', call: () => invoke(ordersRoute.GET, makeRequest('http://localhost/api/orders')) },
  {
    name: 'POST /api/orders',
    call: () => invoke(ordersRoute.POST, makeRequest('http://localhost/api/orders', json(orderBody()))),
  },
  {
    name: 'GET /api/orders/[id]',
    call: () => invoke(orderDetailRoute.GET, makeRequest('http://localhost/api/orders/x'), ctx(PRODUCT_ID.toString())),
  },
  {
    name: 'PATCH /api/orders/[id]',
    call: () =>
      invoke(orderDetailRoute.PATCH, makeRequest('http://localhost/api/orders/x', json({ orderStatus: 'shipped' })), ctx(PRODUCT_ID.toString())),
  },
  {
    name: 'PUT /api/orders/[id]',
    call: () =>
      invoke(orderDetailRoute.PUT, makeRequest('http://localhost/api/orders/x', json({ customerCity: 'Karachi' })), ctx(PRODUCT_ID.toString())),
  },
  {
    name: 'DELETE /api/orders/[id]',
    call: () =>
      invoke(orderDetailRoute.DELETE, makeRequest('http://localhost/api/orders/x', { method: 'DELETE' }), ctx(PRODUCT_ID.toString())),
  },
  { name: 'GET /api/returns', call: () => invoke(returnsRoute.GET, makeRequest('http://localhost/api/returns')) },
  {
    name: 'POST /api/returns',
    call: () =>
      invoke(
        returnsRoute.POST,
        makeRequest(
          'http://localhost/api/returns',
          json({ orderId: PRODUCT_ID.toString(), items: [{ productId: PRODUCT_ID.toString(), quantity: 1, reason: 'Wrong size' }], refundAmount: 0 })
        )
      ),
  },
  {
    name: 'GET /api/returns/[id]',
    call: () => invoke(returnDetailRoute.GET, makeRequest('http://localhost/api/returns/x'), ctx(PRODUCT_ID.toString())),
  },
  { name: 'GET /api/suppliers', call: () => invoke(suppliersRoute.GET, makeRequest('http://localhost/api/suppliers')) },
  {
    name: 'POST /api/suppliers',
    call: () =>
      invoke(suppliersRoute.POST, makeRequest('http://localhost/api/suppliers', json({ name: 'New Supplier', city: 'Gujranwala' }))),
  },
  {
    name: 'GET /api/suppliers/[id]',
    call: () => invoke(supplierDetailRoute.GET, makeRequest('http://localhost/api/suppliers/x'), ctx(SUPPLIER_ID.toString())),
  },
  {
    name: 'PUT /api/suppliers/[id]',
    call: () =>
      invoke(supplierDetailRoute.PUT, makeRequest('http://localhost/api/suppliers/x', json({ city: 'Multan' })), ctx(SUPPLIER_ID.toString())),
  },
  {
    name: 'DELETE /api/suppliers/[id]',
    call: () =>
      invoke(supplierDetailRoute.DELETE, makeRequest('http://localhost/api/suppliers/x', { method: 'DELETE' }), ctx(SUPPLIER_ID.toString())),
  },
]

/** Both gates, because routes differ in which one they hit first. */
const denyOnce = (error: Error) => {
  vi.mocked(authorize).mockRejectedValueOnce(error)
  vi.mocked(authorizeScoped).mockRejectedValueOnce(error)
  vi.mocked(authorizeStockWrite).mockRejectedValueOnce(error)
}

describe('401 on every Phase 5 route (TESTS: API)', () => {
  it.each(ALL_PHASE5_ROUTES.map((r) => [r.name, r.call] as const))(
    '%s refuses an unauthenticated caller',
    async (_name, call) => {
      denyOnce(new AuthenticationError())
      const res = await call()
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.success).toBe(false)
      expect(body.error.code).toBe('UNAUTHENTICATED')
    }
  )
})

describe('403 on every Phase 5 route (TESTS: API)', () => {
  it.each(ALL_PHASE5_ROUTES.map((r) => [r.name, r.call] as const))(
    '%s refuses a role without the grant',
    async (_name, call) => {
      denyOnce(new AuthorizationError('inventory', 'create'))
      const res = await call()
      expect(res.status).toBe(403)
      expect((await res.json()).success).toBe(false)
    }
  )
})

describe('a Partner without permission cannot write (TESTS: API)', () => {
  it('blocks a Sheikhupura purchase for a Lahore-only Partner and writes nothing', async () => {
    vi.mocked(authorizeStockWrite).mockRejectedValueOnce(new AuthorizationError('inventory', 'create'))
    const res = await purchasesRoute.POST(makeRequest('http://localhost/api/purchases', json(purchaseBody())))

    expect(res.status).toBe(403)
    expect(cols.purchases().docs).toHaveLength(1) // the seed only
    expect(cols.movements().docs).toHaveLength(1)
    expect(cols.ledger().docs).toHaveLength(0)
    expect(stockQty(PRODUCT_ID.toString(), 'sheikhupura')).toBe(5)
  })

  it('blocks an order create and reserves no stock', async () => {
    vi.mocked(authorize).mockRejectedValueOnce(new AuthorizationError('sales', 'create'))
    const res = await ordersRoute.POST(makeRequest('http://localhost/api/orders', json(orderBody())))

    expect(res.status).toBe(403)
    expect(cols.orders().docs).toHaveLength(0)
    expect(cols.movements().docs).toHaveLength(1)
  })

  it('blocks a product create and stores no row', async () => {
    vi.mocked(authorize).mockRejectedValueOnce(new AuthorizationError('inventory', 'create'))
    const res = await productsRoute.POST(makeRequest('http://localhost/api/products', json(productBody())))

    expect(res.status).toBe(403)
    expect(cols.products().docs).toHaveLength(1)
  })

  it('blocks a movement correction and leaves the ledger append-only', async () => {
    const before = cols.movements().docs.map((d) => ({ ...d }))
    vi.mocked(authorizeStockWrite).mockRejectedValueOnce(new AuthorizationError('inventory', 'create'))
    const res = await reverseMovementRoute.POST(
      makeRequest('http://localhost/api/stock/movements/x/reverse', json({ reason: 'Wrong quantity' })),
      ctx(MOVEMENT_ID.toString())
    )

    expect(res.status).toBe(403)
    expect(cols.movements().docs).toEqual(before)
  })

  it('keeps reads open for a view-only role', async () => {
    const res = await summaryRoute.GET(makeRequest('http://localhost/api/stock/summary'))
    expect(res.status).toBe(200)
    expect(vi.mocked(authorize)).toHaveBeenCalledWith('inventory', 'view')
    // The SPEC §4.2 grant matrix itself is pinned in authorization-matrix.test.ts.
  })
})

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

describe('validation on the Phase 5 write routes (TESTS: API)', () => {
  it('rejects malformed products and stores nothing', async () => {
    const cases: Record<string, unknown>[] = [
      { ...productBody(), sku: '' },
      { ...productBody(), name: '' },
      { ...productBody(), category: '' },
      { ...productBody(), cost: -1 },
      { ...productBody(), sellingPrice: 10.5 },
      { ...productBody(), reorderLevel: -3 },
      { ...productBody(), variants: Array.from({ length: 51 }, (_, i) => ({ name: `v${i}` })) },
    ]
    for (const body of cases) {
      const res = await productsRoute.POST(makeRequest('http://localhost/api/products', json(body)))
      expect(res.status).toBe(400)
    }
    expect(cols.products().docs).toHaveLength(1)
  })

  it('refuses a duplicate SKU — SKUs are unique', async () => {
    const res = await productsRoute.POST(
      makeRequest('http://localhost/api/products', json(productBody({ sku: 'SKU-SEED-1' })))
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.details[0].path).toBe('sku')
  })

  it('rejects impossible purchases', async () => {
    const cases: Record<string, unknown>[] = [
      purchaseBody({ quantity: 0 }),
      purchaseBody({ quantity: 2.5 }),
      purchaseBody({ unitCost: 0 }),
      purchaseBody({ location: 'multan' }),
      purchaseBody({ productId: 'not-an-id' }),
    ]
    for (const body of cases) {
      const res = await purchasesRoute.POST(makeRequest('http://localhost/api/purchases', json(body)))
      expect(res.status).toBe(400)
    }
    expect(cols.purchases().docs).toHaveLength(1)
    expect(cols.movements().docs).toHaveLength(1)
  })

  it('404s a purchase for an unknown product instead of inventing one', async () => {
    const res = await purchasesRoute.POST(
      makeRequest('http://localhost/api/purchases', json(purchaseBody({ productId: new ObjectId().toString() })))
    )
    expect(res.status).toBe(404)
  })

  it('rejects orders with no items, no channel or an unknown product', async () => {
    const cases: Record<string, unknown>[] = [
      orderBody({ items: [] }),
      orderBody({ salesChannel: '' }),
      orderBody({ customerName: '' }),
      orderBody({ shipFromLocation: 'islamabad' }),
      orderBody({ items: [{ productId: new ObjectId().toString(), quantity: 1 }] }),
    ]
    for (const body of cases) {
      const res = await ordersRoute.POST(makeRequest('http://localhost/api/orders', json(body)))
      expect(res.status).toBe(400)
    }
    expect(cols.orders().docs).toHaveLength(0)
    expect(cols.movements().docs).toHaveLength(1)
  })

  it('never trusts a price sent by the client', async () => {
    const res = await ordersRoute.POST(
      makeRequest(
        'http://localhost/api/orders',
        json(orderBody({ items: [{ productId: PRODUCT_ID.toString(), quantity: 2, unitPrice: 1, productName: 'Free stuff' }] }))
      )
    )
    expect(res.status).toBe(201)
    const { data } = await res.json()
    const order = data.order
    expect(order.items[0].unitPrice).toBe(120_000)
    expect(order.items[0].productName).toBe('Seed Cushion')
    expect(order.total).toBe(240_000)
  })

  it('refuses a transfer to the same location', async () => {
    const res = await transferRoute.POST(
      makeRequest('http://localhost/api/stock/transfer', json(transferBody({ toLocation: 'sheikhupura' })))
    )
    expect(res.status).toBe(400)
  })

  it('refuses a count that matches the system quantity — no silent no-op movement', async () => {
    const res = await stockRoute.POST(
      makeRequest(
        'http://localhost/api/stock',
        json({ productId: PRODUCT_ID.toString(), location: 'sheikhupura', countedQuantity: 5, reason: 'Recount' })
      )
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toBe('No adjustment needed')
  })

  it('400s a malformed id and 404s an unknown one', async () => {
    expect((await productDetailRoute.GET(makeRequest('http://localhost/api/products/x'), ctx('nope'))).status).toBe(400)
    expect(
      (await productDetailRoute.GET(makeRequest('http://localhost/api/products/x'), ctx(new ObjectId().toString()))).status
    ).toBe(404)
  })
})

/* -------------------------------------------------------------------------- */
/*  Idempotency                                                               */
/* -------------------------------------------------------------------------- */

describe('idempotency keys (BUILD #7)', () => {
  it('replays a retried product create', async () => {
    const key = freshKey()
    const first = await productsRoute.POST(
      makeRequest('http://localhost/api/products', json(productBody({ idempotencyKey: key })))
    )
    expect(first.status).toBe(201)
    const created = (await first.json()).data

    const second = await productsRoute.POST(
      makeRequest('http://localhost/api/products', json(productBody({ idempotencyKey: key })))
    )
    expect(second.status).toBe(200)
    expect((await second.json()).data._id).toBe(created._id)
    expect(cols.products().docs).toHaveLength(2)
  })

  it('replays a retried purchase without adding stock or a second expense', async () => {
    const key = freshKey()
    const first = await purchasesRoute.POST(
      makeRequest('http://localhost/api/purchases', json(purchaseBody({ quantity: 3, unitCost: 60_000, idempotencyKey: key })))
    )
    expect(first.status).toBe(201)
    const afterFirst = stockQty(PRODUCT_ID.toString(), 'sheikhupura')

    const second = await purchasesRoute.POST(
      makeRequest('http://localhost/api/purchases', json(purchaseBody({ quantity: 3, unitCost: 60_000, idempotencyKey: key })))
    )
    expect(second.status).toBe(200)
    expect((await second.json()).data.replay).toBe(true)

    expect(stockQty(PRODUCT_ID.toString(), 'sheikhupura')).toBe(afterFirst)
    expect(cols.purchases().docs).toHaveLength(2)
    expect(ledgerByCategory('product_purchasing')).toHaveLength(1)
    expect(cols.movements().docs.filter((d) => d.movementType === 'purchase_in')).toHaveLength(2)
  })

  it('replays a retried order without double-reserving stock', async () => {
    const key = freshKey()
    await purchasesRoute.POST(
      makeRequest('http://localhost/api/purchases', json(purchaseBody({ quantity: 5, unitCost: 60_000 })))
    )
    const before = stockQty(PRODUCT_ID.toString(), 'sheikhupura')

    const first = await ordersRoute.POST(
      makeRequest('http://localhost/api/orders', json(orderBody({ quantity: undefined, items: [{ productId: PRODUCT_ID.toString(), quantity: 2 }], idempotencyKey: key })))
    )
    expect(first.status).toBe(201)
    const reserved = before - stockQty(PRODUCT_ID.toString(), 'sheikhupura')
    expect(reserved).toBe(2)

    const second = await ordersRoute.POST(
      makeRequest('http://localhost/api/orders', json(orderBody({ items: [{ productId: PRODUCT_ID.toString(), quantity: 2 }], idempotencyKey: key })))
    )
    expect(second.status).toBe(200)
    expect(stockQty(PRODUCT_ID.toString(), 'sheikhupura')).toBe(before - 2)
    expect(cols.orders().docs).toHaveLength(1)
    expect(cols.movements().docs.filter((d) => d.movementType === 'sale_out')).toHaveLength(1)
  })

  it('replays a retried transfer', async () => {
    const key = freshKey()
    await transferRoute.POST(makeRequest('http://localhost/api/stock/transfer', json(transferBody({ idempotencyKey: key }))))
    const lahore = stockQty(PRODUCT_ID.toString(), 'lahore')

    const again = await transferRoute.POST(
      makeRequest('http://localhost/api/stock/transfer', json(transferBody({ idempotencyKey: key })))
    )
    expect(again.status).toBe(200)
    expect((await again.json()).data.replay).toBe(true)
    expect(stockQty(PRODUCT_ID.toString(), 'lahore')).toBe(lahore)
  })

  it('posts the COD income exactly once however often cash receipt is retried', async () => {
    const order = await createDeliveredOrder()
    const first = await orderDetailRoute.PATCH(
      makeRequest('http://localhost/api/orders/x', json({ cashReceived: true })),
      ctx(order.id)
    )
    expect(first.status).toBe(200)
    await orderDetailRoute.PATCH(makeRequest('http://localhost/api/orders/x', json({ cashReceived: true })), ctx(order.id))
    await orderDetailRoute.PATCH(makeRequest('http://localhost/api/orders/x', json({ cashReceived: true })), ctx(order.id))

    expect(ledgerByCategory('sales_revenue')).toHaveLength(1)
    const latest = await orderDetailRoute.GET(makeRequest('http://localhost/api/orders/x'), ctx(order.id))
    const doc = (await latest.json()).data
    expect(doc.paymentStatus).toBe('received')
  })
})

/* -------------------------------------------------------------------------- */
/*  Concurrency and negative stock                                            */
/* -------------------------------------------------------------------------- */

describe('concurrency: two simultaneous sales of the last unit (BUILD #7)', () => {
  it('lets exactly one of the two orders succeed', async () => {
    // One sellable unit at Lahore.
    mem.collection('stock').push({
      _id: new ObjectId(),
      productId: PRODUCT_ID,
      location: 'lahore',
      quantity: 1,
      lastUpdated: KARACHI_TODAY,
      updatedAt: KARACHI_TODAY,
    })

    const bodies = [
      orderBody({ shipFromLocation: 'lahore', idempotencyKey: freshKey('last-a') }),
      orderBody({ shipFromLocation: 'lahore', idempotencyKey: freshKey('last-b') }),
    ]
    const responses = await Promise.all(
      bodies.map((body) => ordersRoute.POST(makeRequest('http://localhost/api/orders', json(body))))
    )
    const statuses = responses.map((r) => r.status).sort()
    expect(statuses).toEqual([201, 409])

    const failures = await Promise.all(responses.filter((r) => r.status !== 201).map((r) => r.json()))
    expect(failures[0].error.code).toBe('INSUFFICIENT_STOCK')

    expect(cols.orders().docs).toHaveLength(1)
    expect(cols.movements().docs.filter((d) => d.movementType === 'sale_out')).toHaveLength(1)
    expect(stockQty(PRODUCT_ID.toString(), 'lahore')).toBe(0)
  })

  it('rolls the failed order back completely — no orphan movements or rows', async () => {
    mem.collection('stock').push({
      _id: new ObjectId(),
      productId: PRODUCT_ID,
      location: 'lahore',
      quantity: 1,
      lastUpdated: KARACHI_TODAY,
      updatedAt: KARACHI_TODAY,
    })
    const loserKey = freshKey('loser')
    const [a, b] = await Promise.all([
      ordersRoute.POST(makeRequest('http://localhost/api/orders', json(orderBody({ shipFromLocation: 'lahore', idempotencyKey: freshKey('w-a') })))),
      ordersRoute.POST(makeRequest('http://localhost/api/orders', json(orderBody({ shipFromLocation: 'lahore', idempotencyKey: loserKey })))),
    ])
    expect([a.status, b.status].sort()).toEqual([201, 409])

    const loser = await ordersRoute.POST(
      makeRequest('http://localhost/api/orders', json(orderBody({ shipFromLocation: 'sheikhupura', idempotencyKey: loserKey })))
    )
    // The rolled-back attempt left no order behind, so the same key now creates
    // a fresh order rather than replaying a phantom.
    expect(loser.status).toBe(201)
    expect(cols.orders().docs).toHaveLength(2)
  })
})

describe('negative stock is blocked unless the Founder allows it (BUILD #3)', () => {
  it('refuses to sell what is not there', async () => {
    const res = await ordersRoute.POST(
      makeRequest('http://localhost/api/orders', json(orderBody({ items: [{ productId: PRODUCT_ID.toString(), quantity: 50 }] })))
    )
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('INSUFFICIENT_STOCK')
    expect(stockQty(PRODUCT_ID.toString(), 'sheikhupura')).toBe(5)
    expect(cols.movements().docs.filter((d) => d.movementType === 'sale_out')).toHaveLength(0)
  })

  it('refuses a transfer beyond what the source holds', async () => {
    const res = await transferRoute.POST(
      makeRequest('http://localhost/api/stock/transfer', json(transferBody({ quantity: 99 })))
    )
    expect(res.status).toBe(409)
    expect(stockQty(PRODUCT_ID.toString(), 'lahore')).toBe(0)
  })

  it('allows it once the Founder flips the setting, and the movement is real', async () => {
    cols.settings().docs[0].allowNegativeStock = true

    const res = await ordersRoute.POST(
      makeRequest('http://localhost/api/orders', json(orderBody({ items: [{ productId: PRODUCT_ID.toString(), quantity: 8 }] })))
    )
    expect(res.status).toBe(201)
    expect(stockQty(PRODUCT_ID.toString(), 'sheikhupura')).toBe(-3)
    expect(cols.movements().docs.filter((d) => d.movementType === 'sale_out')).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/*  Lifecycle: cancel restores, nothing double counts                         */
/* -------------------------------------------------------------------------- */

describe('order lifecycle (BUILD #5)', () => {
  it('a cancelled order restores its reservation exactly once', async () => {
    const created = await ordersRoute.POST(makeRequest('http://localhost/api/orders', json(orderBody({ items: [{ productId: PRODUCT_ID.toString(), quantity: 2 }] }))))
    expect(created.status).toBe(201)
    const orderId = (await created.json()).data.order._id
    expect(stockQty(PRODUCT_ID.toString(), 'sheikhupura')).toBe(3)

    const cancel = await orderDetailRoute.PATCH(
      makeRequest('http://localhost/api/orders/x', json({ orderStatus: 'cancelled' })),
      ctx(String(orderId))
    )
    expect(cancel.status).toBe(200)
    expect(stockQty(PRODUCT_ID.toString(), 'sheikhupura')).toBe(5)
    expect(cols.movements().docs.filter((d) => d.movementType === 'sale_out' && d.isReversal)).toHaveLength(1)

    // Cancelling again cannot restore a second time.
    const again = await orderDetailRoute.PATCH(
      makeRequest('http://localhost/api/orders/x', json({ orderStatus: 'cancelled' })),
      ctx(String(orderId))
    )
    expect(again.status).toBe(200)
    expect(stockQty(PRODUCT_ID.toString(), 'sheikhupura')).toBe(5)
    expect(cols.movements().docs.filter((d) => d.movementType === 'sale_out' && d.isReversal)).toHaveLength(1)
  })

  it('refuses to cancel an order whose cash is already in the ledger', async () => {
    const order = await createDeliveredOrder()
    const res = await orderDetailRoute.PATCH(
      makeRequest('http://localhost/api/orders/x', json({ orderStatus: 'cancelled' })),
      ctx(order.id)
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toBe('Order cash already received')
  })

  it('refuses an impossible transition', async () => {
    const created = await ordersRoute.POST(makeRequest('http://localhost/api/orders', json(orderBody())))
    const orderId = (await created.json()).data.order._id
    const res = await orderDetailRoute.PATCH(
      makeRequest('http://localhost/api/orders/x', json({ orderStatus: 'delivered' })),
      ctx(String(orderId))
    )
    expect(res.status).toBe(400)
  })

  it('dispatch posts the courier expense once and the cost is ours regardless of COD', async () => {
    const created = await ordersRoute.POST(
      makeRequest('http://localhost/api/orders', json(orderBody({ courierCharges: 15_000, shippingCost: 20_000 })))
    )
    const orderId = (await created.json()).data.order._id
    for (let attempt = 0; attempt < 2; attempt++) {
      const ship = await orderDetailRoute.PATCH(makeRequest('http://localhost/api/orders/x', json({ orderStatus: 'shipped' })), ctx(String(orderId)))
      expect(ship.status).toBe(200)
    }
    expect(ledgerByCategory('shipping_courier')).toHaveLength(1)
    expect(sum(ledgerByCategory('shipping_courier'))).toBe(15_000)
    expect(ledgerByCategory('sales_revenue')).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/*  Returns                                                                   */
/* -------------------------------------------------------------------------- */

describe('returns (BUILD #5)', () => {
  it('restocks by default and keeps the returned pool separate', async () => {
    const order = await createDeliveredOrder(2)
    const res = await returnsRoute.POST(
      makeRequest(
        'http://localhost/api/returns',
        json({
          orderId: order.id,
          items: [{ productId: PRODUCT_ID.toString(), quantity: 1, reason: 'Colour was wrong' }],
          refundAmount: 120_000,
          courierCost: 5_000,
        })
      )
    )
    expect(res.status).toBe(201)

    const derived = derivedPools()
    // 5 seeded + 10 purchased − 2 sold by the order + 1 restocked by the return.
    expect(derived.get(`${PRODUCT_ID}|sheikhupura`)?.available).toBe(14)
    expect(derived.get(`${PRODUCT_ID}|sheikhupura`)?.returned).toBe(1)
    // Projection and derivation agree.
    expect(stockQty(PRODUCT_ID.toString(), 'sheikhupura')).toBe(14)

    expect(sum(ledgerByCategory('refunds_return_costs'))).toBe(125_000)
  })

  it('cannot return more than was sold', async () => {
    const order = await createDeliveredOrder(1)
    const res = await returnsRoute.POST(
      makeRequest(
        'http://localhost/api/returns',
        json({ orderId: order.id, items: [{ productId: PRODUCT_ID.toString(), quantity: 2, reason: 'Both broken' }], refundAmount: 0 })
      )
    )
    expect(res.status).toBe(400)
    expect(cols.movements().docs.filter((d) => d.movementType === 'return_restock')).toHaveLength(0)
  })

  it('refuses a refund larger than the customer was charged', async () => {
    const order = await createDeliveredOrder(1)
    const res = await returnsRoute.POST(
      makeRequest(
        'http://localhost/api/returns',
        json({ orderId: order.id, items: [{ productId: PRODUCT_ID.toString(), quantity: 1, reason: 'Damaged in transit' }], refundAmount: 999_999_999 })
      )
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toBe('Refund exceeds order total')
  })

  it('marks damaged and written-off returns Founder-only', async () => {
    const order = await createDeliveredOrder(1)
    vi.mocked(requireFounder).mockRejectedValueOnce(new AuthorizationError('inventory', 'create'))
    const res = await returnsRoute.POST(
      makeRequest(
        'http://localhost/api/returns',
        json({ orderId: order.id, items: [{ productId: PRODUCT_ID.toString(), quantity: 1, reason: 'Snapped' }], outcome: 'damaged', refundAmount: 0 })
      )
    )
    expect(res.status).toBe(403)
    expect(cols.movements().docs.filter((d) => d.movementType === 'return_damaged')).toHaveLength(0)
  })

  it('a damaged return joins the damaged pool and never becomes sellable', async () => {
    const order = await createDeliveredOrder(2)
    const res = await returnsRoute.POST(
      makeRequest(
        'http://localhost/api/returns',
        json({
          orderId: order.id,
          items: [{ productId: PRODUCT_ID.toString(), quantity: 1, reason: 'Fabric torn', outcome: 'damaged' }],
          refundAmount: 0,
        })
      )
    )
    expect(res.status).toBe(201)
    const pool = derivedPools().get(`${PRODUCT_ID}|sheikhupura`)!
    expect(pool.damaged).toBe(1)
    expect(pool.returned).toBe(1)
    // 5 seeded + 10 purchased − 2 sold: a damaged return never re-enters the
    // sellable pool, so `available` stays exactly where the sale left it.
    expect(pool.available).toBe(13)
  })

  it('refuses a return on an order that was never delivered', async () => {
    const created = await ordersRoute.POST(makeRequest('http://localhost/api/orders', json(orderBody())))
    const orderId = (await created.json()).data.order._id
    const res = await returnsRoute.POST(
      makeRequest(
        'http://localhost/api/returns',
        json({ orderId: String(orderId), items: [{ productId: PRODUCT_ID.toString(), quantity: 1, reason: 'No' }], refundAmount: 0 })
      )
    )
    expect(res.status).toBe(400)
  })
})

/* -------------------------------------------------------------------------- */
/*  Movement corrections                                                      */
/* -------------------------------------------------------------------------- */

describe('movement corrections are linked reversals (BUILD #3)', () => {
  it('a reversal cancels the original in every derived figure', async () => {
    const res = await reverseMovementRoute.POST(
      makeRequest('http://localhost/api/stock/movements/x/reverse', json({ reason: 'Supplier shipped 4, we counted 5' })),
      ctx(MOVEMENT_ID.toString())
    )
    expect(res.status).toBe(200)

    expect(cols.movements().docs).toHaveLength(2)
    const reversal = cols.movements().docs[1]
    expect(reversal).toMatchObject({ isReversal: true, movementType: 'purchase_in', quantity: 5, reversesId: MOVEMENT_ID })
    expect(cols.movements().docs[0].status).toBe('reversed')

    expect(derivedPools().get(`${PRODUCT_ID}|sheikhupura`)).toMatchObject({ available: 0, damaged: 0, returned: 0 })
    expect(stockQty(PRODUCT_ID.toString(), 'sheikhupura')).toBe(0)
  })

  it('refuses to reverse a reversal and refuses a double correction', async () => {
    await reverseMovementRoute.POST(
      makeRequest('http://localhost/api/stock/movements/x/reverse', json({ reason: 'Wrong count' })),
      ctx(MOVEMENT_ID.toString())
    )
    const again = await reverseMovementRoute.POST(
      makeRequest('http://localhost/api/stock/movements/x/reverse', json({ reason: 'Again' })),
      ctx(MOVEMENT_ID.toString())
    )
    expect(again.status).toBe(400)

    const reversalId = cols.movements().docs[1]._id as ObjectId
    const reverseTheReversal = await reverseMovementRoute.POST(
      makeRequest('http://localhost/api/stock/movements/x/reverse', json({ reason: 'Undo the undo' })),
      ctx(reversalId.toString())
    )
    expect(reverseTheReversal.status).toBe(400)
  })

  it('the ledger is append-only: no route exports a mutation that edits a movement', async () => {
    const movementsDir = await import('@/app/api/stock/movements/route')
    expect((movementsDir as Record<string, unknown>).PUT).toBeUndefined()
    expect((movementsDir as Record<string, unknown>).PATCH).toBeUndefined()
    expect((movementsDir as Record<string, unknown>).DELETE).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/*  Products and suppliers: archive, never hard-delete                        */
/* -------------------------------------------------------------------------- */

describe('no hard deletes (BUILD #1, #2)', () => {
  it('archiving a product keeps the row and stops new orders', async () => {
    const res = await productDetailRoute.DELETE(
      makeRequest('http://localhost/api/products/x', { method: 'DELETE' }),
      ctx(PRODUCT_ID.toString())
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data.archived).toBe(true)
    expect(cols.products().docs).toHaveLength(1)
    expect(cols.products().docs[0].isActive).toBe(false)

    const order = await ordersRoute.POST(makeRequest('http://localhost/api/orders', json(orderBody())))
    expect(order.status).toBe(400)
  })

  it('archiving a supplier keeps the row', async () => {
    const res = await supplierDetailRoute.DELETE(
      makeRequest('http://localhost/api/suppliers/x', { method: 'DELETE' }),
      ctx(SUPPLIER_ID.toString())
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data.archived).toBe(true)
    expect(cols.suppliers().docs).toHaveLength(1)
    expect(cols.suppliers().docs[0].isActive).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/*  Reconciliation: inventory, orders, ledger and P&L all agree               */
/* -------------------------------------------------------------------------- */

describe('reconciliation after a full sequence (TESTS: Reconciliation)', () => {
  it('purchase → transfer → sale → deliver → return → damage closes on every figure', async () => {
    // A product with no history at all: the first receipt sets the WAC.
    const made = await productsRoute.POST(
      makeRequest('http://localhost/api/products', json(productBody({ sku: 'RECON-1', cost: 50_000, sellingPrice: 120_000 })))
    )
    const product = (await made.json()).data as Doc & { _id: string; cost: number }
    expect(made.status).toBe(201)
    const pid = String(product._id)
    const productId = new ObjectId(pid)

    // 1. Purchase 10 @ 60.00 into Sheikhupura.
    const purch = await purchasesRoute.POST(
      makeRequest('http://localhost/api/purchases', json({ productId: pid, location: 'sheikhupura', quantity: 10, unitCost: 60_000 }))
    )
    expect(purch.status).toBe(201)
    const purchaseResult = await purch.json()
    expect(purchaseResult.data.wacAfter).toBe(60_000)
    expect(stockQty(pid, 'sheikhupura')).toBe(10)

    // 2. Transfer 4 to Lahore. Not a purchase, not a sale: no ledger row.
    const transfer = await transferRoute.POST(
      makeRequest('http://localhost/api/stock/transfer', json({ productId: pid, quantity: 4, fromLocation: 'sheikhupura', toLocation: 'lahore' }))
    )
    expect(transfer.status).toBe(200)
    expect(stockQty(pid, 'sheikhupura')).toBe(6)
    expect(stockQty(pid, 'lahore')).toBe(4)
    expect(cols.ledger().docs.filter((d) => d.category === undefined || d.category === null)).toHaveLength(0)

    // 3. Order 2 from Lahore, 20.00 shipping paid by the customer, 15.00 courier cost to us.
    const orderRes = await ordersRoute.POST(
      makeRequest(
        'http://localhost/api/orders',
        json({
          customerName: 'Bilal Ahmed',
          customerPhone: '0321-9999999',
          customerCity: 'Lahore',
          customerAddress: 'Flat 2, Gulberg III',
          items: [{ productId: pid, quantity: 2 }],
          shippingCost: 20_000,
          courierCharges: 15_000,
          salesChannel: 'website',
          shipFromLocation: 'lahore',
        })
      )
    )
    expect(orderRes.status).toBe(201)
    const orderJSON = (await orderRes.json()).data
    const order = orderJSON.order as Doc
    const orderId = String(order._id)
    expect(order.total).toBe(260_000)
    expect(stockQty(pid, 'lahore')).toBe(2)

    // 4. Dispatch, then deliver, then confirm the COD cash.
    expect((await orderDetailRoute.PATCH(makeRequest('http://localhost/api/orders/x', json({ orderStatus: 'shipped' })), ctx(orderId))).status).toBe(200)
    expect(ledgerByCategory('shipping_courier')).toHaveLength(1)
    expect((await orderDetailRoute.PATCH(makeRequest('http://localhost/api/orders/x', json({ orderStatus: 'delivered' })), ctx(orderId))).status).toBe(200)
    expect(ledgerByCategory('sales_revenue')).toHaveLength(0) // income waits for cash
    expect((await orderDetailRoute.PATCH(makeRequest('http://localhost/api/orders/x', json({ cashReceived: true })), ctx(orderId))).status).toBe(200)
    expect(ledgerByCategory('sales_revenue')).toHaveLength(1)
    expect(sum(ledgerByCategory('sales_revenue'))).toBe(260_000)

    // 5. Return one unit restocked and one damaged, refund the unit, pay the
    //    return courier.
    const ret = await returnsRoute.POST(
      makeRequest(
        'http://localhost/api/returns',
        json({
          orderId,
          items: [
            { productId: pid, quantity: 1, reason: 'Too large', outcome: 'restock' },
            { productId: pid, quantity: 1, reason: 'Stained', outcome: 'damaged' },
          ],
          refundAmount: 120_000,
          courierCost: 5_000,
        })
      )
    )
    expect(ret.status).toBe(201)

    // 6. One unit in the Sheikhupura store is found broken.
    const dmg = await damageRoute.POST(
      makeRequest('http://localhost/api/stock/damage', json({ productId: pid, location: 'sheikhupura', quantity: 1, type: 'damage', reason: 'Water damage' }))
    )
    expect(dmg.status).toBe(200)

    /* ---- the projections match the derivation exactly ---- */
    const movements = cols
      .movements()
      .docs.filter((d) => String(d.productId) === pid) as unknown as MovementLike[]
    const derived = deriveStock(movements.map((m) => ({ ...m, productId: String(m.productId) })))
    const sheikhupura = derived.get(`${pid}|sheikhupura`)!
    const lahore = derived.get(`${pid}|lahore`)!

    expect(sheikhupura).toEqual({ available: 5, damaged: 1, returned: 0 })
    expect(lahore).toEqual({ available: 3, damaged: 1, returned: 2 })
    expect(stockQty(pid, 'sheikhupura')).toBe(sheikhupura.available)
    expect(stockQty(pid, 'lahore')).toBe(lahore.available)

    /* ---- weighted average COGS and valuation ---- */
    const freshProduct = cols.products().docs.find((d) => String(d._id) === pid)!
    expect(freshProduct.cost).toBe(60_000)

    const expectedCogs = 2 * 60_000 - 1 * 60_000 // the restocked unit's cost comes back
    expect(cogsFromMovements(movements.map((m) => ({ ...m, productId: String(m.productId) })))).toBe(expectedCogs)
    const totalAvailable = sheikhupura.available + lahore.available
    const expectedValuation = totalAvailable * 60_000
    expect(expectedValuation).toBe(8 * 60_000)

    const summary = await summaryRoute.GET(makeRequest(`http://localhost/api/stock/summary?includeArchived=true`))
    const summaryData = (await summary.json()).data
    const summaryRow = summaryData.items.find((i: Doc) => i._id === pid)
    expect(summaryRow.valuation).toBe(expectedValuation)
    expect(summaryRow.totalAvailable).toBe(totalAvailable)
    expect(summaryRow.totalDamaged).toBe(2)
    expect(summaryRow.totalReturned).toBe(2)

    /* ---- the P&L carries the real COGS, not the provisional one ---- */
    const pl = await plRoute.GET(makeRequest(`http://localhost/api/finance/pl?period=month&date=${TODAY_ISO}`))
    expect(pl.status).toBe(200)
    const plData = (await pl.json()).data
    expect(plData.profitLoss.cogsProvisional).toBe(false)
    expect(plData.profitLoss.cogs).toBe(expectedCogs)
    expect(plData.profitLoss.revenue).toBe(260_000)
    expect(plData.profitLoss.refunds).toBe(125_000)
    expect(plData.profitLoss.netSales).toBe(135_000)
    expect(plData.profitLoss.grossProfit).toBe(135_000 - expectedCogs)
    // `product_purchasing` is deliberately not an operating expense: the goods
    // cost was already charged through COGS.
    expect(plData.profitLoss.operatingExpenses).toBe(15_000)
    expect(plData.profitLoss.netProfit).toBe(135_000 - expectedCogs - 15_000)
    expect(plData.formulas.cogs).not.toContain('PROVISIONAL')

    /* ---- the ledger totals are exactly what the flows claim ---- */
    expect(sum(ledgerByCategory('product_purchasing'))).toBe(600_000)
    expect(sum(ledgerByCategory('shipping_courier'))).toBe(15_000)
    expect(sum(ledgerByCategory('refunds_return_costs'))).toBe(125_000)
    const cash = cols
      .ledger()
      .docs.reduce((balance, d) => {
        const amount = Number(d.amount)
        if (d.type === 'income') return balance + amount
        if (d.type === 'expense') return balance - amount
        return balance
      }, 0)
    expect(cash).toBe(260_000 - 600_000 - 15_000 - 125_000)

    /* ---- nothing was counted twice: every movement has a unique key ---- */
    const keys = cols.movements().docs.map((d) => d.idempotencyKey).filter(Boolean)
    expect(new Set(keys).size).toBe(keys.length)
    expect(cols.orders().docs).toHaveLength(1)
    expect(cols.purchases().docs.filter((d) => String(d.productId) === pid)).toHaveLength(1)
    expect(derivedPoolsFor(productId).get(`${pid}|lahore`)?.available).toBe(lahore.available)

    /* ---- and the audit trail recorded each change ---- */
    const actions = cols.audit().docs.map((d) => d.action)
    for (const expected of ['purchase_created', 'stock_transfer_completed', 'order_created', 'order_status_changed', 'return_created']) {
      expect(actions).toContain(expected)
    }
  })
})

/* ----------------------------- shared helpers ----------------------------- */

/** Every movement in the fake, re-derived through the pure engine. */
function derivedPools(): Map<string, { available: number; damaged: number; returned: number }> {
  const movements = cols.movements().docs.map((m) => ({ ...m, productId: String(m.productId) })) as unknown as MovementLike[]
  return deriveStock(movements)
}

function derivedPoolsFor(_productId: ObjectId) {
  return derivedPools()
}

/**
 * Seed → purchase enough stock → order N → ship → deliver → cash received.
 * Returns the order id. Used by the return, cancel and income tests.
 */
async function createDeliveredOrder(quantity = 1): Promise<{ id: string }> {
  await purchasesRoute.POST(
    makeRequest('http://localhost/api/purchases', json(purchaseBody({ quantity: 10, unitCost: 60_000 })))
  )
  const created = await ordersRoute.POST(
    makeRequest(
      'http://localhost/api/orders',
      json(orderBody({ items: [{ productId: PRODUCT_ID.toString(), quantity }], shippingCost: 20_000, courierCharges: 15_000 }))
    )
  )
  expect(created.status).toBe(201)
  const body = (await created.json()).data
  const id = String((body.order as Doc)._id)
  expect(id).toMatch(/^[0-9a-f]{24}$/)
  expect((await orderDetailRoute.PATCH(makeRequest('http://localhost/api/orders/x', json({ orderStatus: 'shipped' })), ctx(id))).status).toBe(200)
  expect((await orderDetailRoute.PATCH(makeRequest('http://localhost/api/orders/x', json({ orderStatus: 'delivered' })), ctx(id))).status).toBe(200)
  expect((await orderDetailRoute.PATCH(makeRequest('http://localhost/api/orders/x', json({ cashReceived: true })), ctx(id))).status).toBe(200)
  return { id }
}

/* -------------------------------------------------------------------------- */
/*  Sanity guard on the harness itself                                        */
/* -------------------------------------------------------------------------- */

describe('harness', () => {
  it('the fake enforces a unique idempotency index like production', async () => {
    const key = freshKey('uniq')
    await productsRoute.POST(makeRequest('http://localhost/api/products', json(productBody({ sku: 'UNIQ-1', idempotencyKey: key }))))
    await productsRoute.POST(makeRequest('http://localhost/api/products', json(productBody({ sku: 'UNIQ-2', idempotencyKey: key }))))
    expect(cols.products().docs.filter((d) => d.idempotencyKey === key)).toHaveLength(1)
  })

  it('P = paisa helper keeps the SPEC examples honest', () => {
    expect(P(4266.64)).toBe(426_664)
    expect(P(0)).toBe(0)
    // The seeded rows and the P&L window are dated from the same clock as the
    // routes themselves (`getKarachiDate()`), so the reconciliation period
    // always contains the sequence it is checking.
    const seededDate = cols.movements().docs[0].date as Date
    expect(seededDate.toISOString().slice(0, 10)).toBe(TODAY_ISO)
  })
})
