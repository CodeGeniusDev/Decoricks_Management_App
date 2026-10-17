/**
 * Phase 8 integration test — the brief's headline guarantee, run against a REAL
 * MongoDB (hermetic `mongodb-memory-server`, no manual mongod):
 *
 *   "after a full sequence (purchase, sale, return, transfer, expense, refund,
 *    withdrawal), dashboard = reports = ledger = inventory."
 *
 * `buildDashboardMetrics` and `reconcile` take a `Db` directly, so this exercises
 * the actual production code paths — the same ledger read, the same engines, the
 * same per-widget composition — with no mocks standing in for the maths. Every
 * expected figure below is hand-derived from SPEC §5 so a wrong number fails,
 * not just an inconsistent one.
 */
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { karachiMidnight, karachiMonthRange, type DateRange } from '@/lib/finance'
import { fetchLedgerRange } from '@/lib/distribution-service'
import { computeProfitLoss } from '@/lib/profit-loss'
import { periodCogsInput } from '@/lib/cogs-service'
import { getLedgerCollection, getAccountCollection } from '@/lib/models/Ledger'
import { getProductCollection } from '@/lib/models/Product'
import { getStockMovementCollection } from '@/lib/models/Inventory'
import { getBudgetCollection } from '@/lib/models/Operations'
import type { PermissionModule } from '@/lib/models/User'
import { buildDashboardMetrics } from '@/lib/metrics/dashboard-metrics'
import { reconcile } from '@/lib/metrics/reconciliation'

const PKR = (p: number) => Math.round(p * 100) // integer paisa

// A fixed "now" comfortably after every seeded event, inside the test DB only.
const NOW = karachiMidnight(2026, 12, 31)
const RANGE: DateRange = karachiMonthRange(karachiMidnight(2026, 9, 15))
const SEP = (day: number) => new Date(karachiMidnight(2026, 9, day).getTime() + 12 * 3_600_000)

const ALL: PermissionModule[] = ['finance', 'sales', 'inventory', 'budget', 'tasks']

let server: MongoMemoryServer
let client: MongoClient

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } })
  client = new MongoClient(server.getUri())
  await client.connect()
}, 120_000)

afterAll(async () => {
  await client?.close()
  await server?.stop()
})

const CASH = new ObjectId('507f1f77bcf86cd799439011')
const PARTNER = new ObjectId('507f1f77bcf86cd799439022')
const PRODUCT = new ObjectId('507f1f77bcf86cd799439033')
const BUDGET = new ObjectId('507f1f77bcf86cd799439044')

async function freshDb(): Promise<Db> {
  const db = client.db(`phase8_${Date.now()}_${Math.floor(Math.random() * 1e6)}`)
  // One opening account so cash balances have a real anchor.
  await getAccountCollection(db).insertOne({
    _id: CASH,
    name: 'Business Cash',
    kind: 'cash',
    openingBalance: 0,
    isActive: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    createdBy: PARTNER,
  } as never)
  return db
}

async function dropDb(name: string) {
  await client.db(name).dropDatabase()
}

/**
 * Seed the exact 7-event business sequence and its inventory/budget side.
 * Returns the db. Every amount is chosen so the hand-derived totals are clean.
 */
async function seedFullSequence(db: Db) {
  const ledger = getLedgerCollection(db)
  const now = NOW

  await ledger.insertMany([
    // 1. Purchase — reserved COGS category, NOT an operating expense.
    {
      type: 'expense',
      amount: PKR(5000),
      date: SEP(2),
      accountId: CASH,
      category: 'product_purchasing',
      isReversal: false,
      status: 'posted',
      createdBy: PARTNER,
      createdAt: now,
      updatedAt: now,
    },
    // 2. Sale — collected COD revenue.
    {
      type: 'income',
      amount: PKR(3200),
      date: SEP(10),
      accountId: CASH,
      category: 'order_sale',
      isReversal: false,
      status: 'posted',
      createdBy: PARTNER,
      createdAt: now,
      updatedAt: now,
    },
    // 4. Advertising expense — operating, and in the advertising set.
    {
      type: 'expense',
      amount: PKR(2000),
      date: SEP(11),
      accountId: CASH,
      category: 'meta_ads',
      isReversal: false,
      status: 'posted',
      createdBy: PARTNER,
      createdAt: now,
      updatedAt: now,
    },
    // 6. Refund — reserved refunds category.
    {
      type: 'expense',
      amount: PKR(800),
      date: SEP(20),
      accountId: CASH,
      category: 'refunds_return_costs',
      isReversal: false,
      status: 'posted',
      createdBy: PARTNER,
      createdAt: now,
      updatedAt: now,
    },
    // 7. Partner withdrawal — equity outflow, never a P&L expense.
    {
      type: 'partner_withdrawal',
      amount: PKR(1000),
      date: SEP(25),
      accountId: CASH,
      partnerId: PARTNER,
      isReversal: false,
      status: 'posted',
      createdBy: PARTNER,
      createdAt: now,
      updatedAt: now,
    },
  ] as never)

  // Inventory side of 1 (purchase_in), 2 (sale_out), 3 (transfer), 5 (return_restock).
  const mv = (movementType: string, extra: Record<string, unknown>) => ({
    _id: new ObjectId(),
    productId: PRODUCT,
    movementType,
    quantity: 0,
    isReversal: false,
    status: 'posted',
    date: SEP(2),
    createdAt: now,
    createdBy: PARTNER,
    ...extra,
  })
  await getStockMovementCollection(db).insertMany([
    mv('purchase_in', {
      quantity: 10,
      toLocation: 'sheikhupura',
      unitCost: PKR(500),
      date: SEP(2),
    }),
    mv('sale_out', { quantity: 4, fromLocation: 'sheikhupura', unitCost: PKR(500), date: SEP(10) }),
    mv('transfer', {
      quantity: 2,
      fromLocation: 'sheikhupura',
      toLocation: 'lahore',
      unitCost: PKR(500),
      date: SEP(12),
    }),
    mv('return_restock', {
      quantity: 1,
      toLocation: 'sheikhupura',
      unitCost: PKR(500),
      date: SEP(20),
    }),
  ] as never)

  // The product's stored cost IS the weighted average (500 PKR) that valuation and
  // COGS both draw on, so inventory and P&L can never disagree on cost basis.
  await getProductCollection(db).insertOne({
    _id: PRODUCT,
    sku: 'RUG-01',
    name: 'Test Rug',
    category: 'textiles',
    cost: PKR(500),
    sellingPrice: PKR(800),
    reorderLevel: 8, // 7 available ⇒ low stock
    isActive: true,
    createdAt: new Date(0),
    updatedAt: now,
  } as never)

  // One active monthly budget over September, budgeting the advertising category.
  await getBudgetCollection(db).insertOne({
    _id: BUDGET,
    name: 'September Marketing',
    periodKind: 'monthly',
    periodStart: karachiMidnight(2026, 9, 1),
    periodEnd: karachiMidnight(2026, 9, 30),
    status: 'active',
    categories: [{ category: 'meta_ads', budgeted: PKR(3000) }],
    totalBudgeted: PKR(3000),
    createdAt: now,
    updatedAt: now,
  } as never)
}

describe('Phase 8 — full-sequence reconciliation (dashboard = reports = ledger = inventory)', () => {
  let dbName: string
  let db: Db

  beforeEach(async () => {
    db = await freshDb()
    dbName = db.databaseName
    await seedFullSequence(db)
  })

  afterEach(async () => {
    await dropDb(dbName)
  })

  it('every reconciliation equality passes with a zero difference', async () => {
    const report = await reconcile(db, RANGE, NOW)
    const failing = report.checks.filter((c) => !c.pass)
    expect(failing).toEqual([])
    expect(report.allPass).toBe(true)
    for (const c of report.checks) expect(c.difference).toBe(0)
  })

  it('dashboard figures equal the hand-derived SPEC §5 numbers (traceability)', async () => {
    const m = await buildDashboardMetrics({
      db,
      range: RANGE,
      period: 'month',
      viewable: ALL,
      now: NOW,
    })

    // revenue 3,200 − refunds 800 = net 2,400; COGS (4 sold − 1 restocked) × 500 = 1,500;
    // gross 2,400 − 1,500 = 900; operating = advertising 2,000; net 900 − 2,000 = −1,100.
    expect(m.blocks.profit?.revenue.paisa).toBe(PKR(3200))
    expect(m.blocks.profit?.refunds.paisa).toBe(PKR(800))
    expect(m.blocks.profit?.netSales.paisa).toBe(PKR(2400))
    expect(m.blocks.profit?.cogs.paisa).toBe(PKR(1500))
    expect(m.blocks.profit?.cogsProvisional).toBe(false) // real movement COGS, not the purchasing stand-in
    expect(m.blocks.profit?.grossProfit.paisa).toBe(PKR(900))
    expect(m.blocks.profit?.operatingExpenses.paisa).toBe(PKR(2000))
    expect(m.blocks.profit?.netProfit.paisa).toBe(PKR(-1100))

    // Inventory: 7 available × 500 = 3,500; 5 @ sheikhupura + 2 @ lahore.
    expect(m.blocks.inventory?.totalValue.paisa).toBe(PKR(3500))
    expect(m.blocks.inventory?.lowStockCount).toBe(1)

    // Cash: in 3,200; out 5,000+2,000+800+1,000 = 8,800 ⇒ net −5,600.
    expect(m.blocks.cash?.cashIn.paisa).toBe(PKR(3200))
    expect(m.blocks.cash?.cashOut.paisa).toBe(PKR(8800))
    expect(m.blocks.cash?.netCashFlow.paisa).toBe(PKR(-5600))

    // Expenses: advertising is a subset of operating.
    expect(m.blocks.expenses?.total.paisa).toBe(PKR(2000))
    expect(m.blocks.expenses?.advertising.paisa).toBe(PKR(2000))

    // Budget actual equals the September advertising ledger slice. BudgetBlock
    // stores the engine's raw BudgetActuals (integer paisa), not a MoneyValue.
    expect(m.blocks.budget?.[0]?.actuals.totalActual).toBe(PKR(2000))
  })

  it('dashboard net profit equals the reports-path net profit equals the ledger recompute', async () => {
    const m = await buildDashboardMetrics({
      db,
      range: RANGE,
      period: 'month',
      viewable: ALL,
      now: NOW,
    })

    // "reports path": what /api/reports/period derives — the engine over a range
    // read, fed the SAME movement-based COGS the route supplies (mirrors the real
    // route exactly, so this compares the two screens as users actually see them).
    const reportsEntries = await fetchLedgerRange(db, RANGE)
    const suppliedCogs = await periodCogsInput(db, RANGE)
    const reportsPl = computeProfitLoss(reportsEntries, { cogs: suppliedCogs })
    expect(m.blocks.profit?.netProfit.paisa).toBe(reportsPl.netProfit)
    expect(m.blocks.profit?.revenue.paisa).toBe(reportsPl.revenue)

    // "ledger" independent income reduce over the same rows the dashboard used.
    const ledgerRevenue = reportsEntries
      .filter((e) => e.type === 'income')
      .reduce((s, e) => s + (e.isReversal ? -e.amount : e.amount), 0)
    expect(m.blocks.profit?.revenue.paisa).toBe(ledgerRevenue)
  })

  it('never hides a mismatch — money in an unknown account fails the balances check', async () => {
    // Inject one income posted to an account that does not exist. The dashboard
    // balances (Σ known accounts) silently drop it, so they disagree with an
    // independent Σ all account deltas. The panel must expose that, not absorb it.
    const orphan = new ObjectId()
    await getLedgerCollection(db).insertOne({
      type: 'income',
      amount: PKR(100),
      date: SEP(15),
      accountId: orphan, // not present in `accounts`
      category: 'order_sale',
      isReversal: false,
      status: 'posted',
      createdBy: PARTNER,
      createdAt: NOW,
      updatedAt: NOW,
    } as never)

    const report = await reconcile(db, RANGE, NOW)
    expect(report.allPass).toBe(false)

    const balances = report.checks.find((c) => c.name.startsWith('balances'))!
    expect(balances.pass).toBe(false)
    expect(balances.difference).toBe(-PKR(100))
  })
})
