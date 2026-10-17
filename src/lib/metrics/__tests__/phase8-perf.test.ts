/**
 * Phase 8 performance test (brief §6) — hermetic `mongodb-memory-server`, a
 * throwaway database, never the real one.
 *
 * It proves two things the brief demands:
 *   1. The dashboard's period ledger query uses an INDEX and examines only the
 *      rows in the window — verified with `explain('executionStats')`, not a
 *      guess. No COLLSCAN, no whole-collection read for the range.
 *   2. `buildDashboardMetrics` composes every engine over 10,000 ledger rows
 *      within a fast budget, with the real elapsed time printed for the report.
 *
 * The full-history read the dashboard still performs (for CUMULATIVE account
 * balances) is inherent: a running balance is by definition every prior delta.
 * It is measured here, not hidden.
 */
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { karachiMidnight, karachiMonthRange, type DateRange } from '@/lib/finance'
import { ensureLedgerIndexes, getAccountCollection, getLedgerCollection } from '@/lib/models/Ledger'
import type { PermissionModule } from '@/lib/models/User'
import { buildDashboardMetrics } from '@/lib/metrics/dashboard-metrics'

const CASH = new ObjectId('507f1f77bcf86cd799439055')
const DAY = 86_400_000
const TOTAL_ROWS = 10_000
const RANGE: DateRange = karachiMonthRange(karachiMidnight(2026, 6, 15))
const NOW = karachiMidnight(2026, 7, 1)
const ALL: PermissionModule[] = ['finance', 'sales', 'inventory', 'budget', 'tasks']

let server: MongoMemoryServer
let client: MongoClient
let db: Db

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } })
  client = new MongoClient(server.getUri())
  await client.connect()
  db = client.db('phase8_perf')

  await getAccountCollection(db).insertOne({
    _id: CASH,
    name: 'Business Cash',
    kind: 'cash',
    openingBalance: 0,
    isActive: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    createdBy: CASH,
  } as never)

  // Deterministic spread across ~180 days, half income / half expense, so the
  // June window holds a well-understood slice of the 10k rows.
  const jan1 = karachiMidnight(2026, 1, 1).getTime()
  const rows = Array.from({ length: TOTAL_ROWS }, (_, i) => {
    const isIncome = i % 2 === 0
    return {
      type: isIncome ? 'income' : 'expense',
      amount: 1000 + (i % 500),
      date: new Date(jan1 + (i % 180) * DAY + 12 * 3_600_000),
      accountId: CASH,
      category: isIncome ? 'order_sale' : 'meta_ads',
      isReversal: false,
      status: 'posted',
      createdBy: CASH,
      createdAt: NOW,
      updatedAt: NOW,
    }
  })

  await ensureLedgerIndexes(db)
  for (let i = 0; i < rows.length; i += 1000) {
    await getLedgerCollection(db).insertMany(rows.slice(i, i + 1000) as never)
  }
}, 180_000)

afterAll(async () => {
  await client?.close()
  await server?.stop()
})

/** Walk a Mongo explain plan tree and collect every `stage` label. */
function stages(plan: unknown): string[] {
  const p = plan as { stage?: string; inputStage?: unknown; inputStages?: unknown[] }
  const out: string[] = []
  if (p.stage) out.push(p.stage)
  if (p.inputStage) out.push(...stages(p.inputStage))
  if (p.inputStages) for (const child of p.inputStages) out.push(...stages(child))
  return out
}

describe('Phase 8 — dashboard performance at 10,000 ledger rows', () => {
  it('the period ledger query is index-backed and bounded (explain, not assumed)', async () => {
    const explain = await getLedgerCollection(db)
      .find({ date: { $gte: RANGE.start, $lte: RANGE.end } })
      .explain('executionStats')

    const winning = (explain as never as { queryPlanner: { winningPlan: unknown } }).queryPlanner
      .winningPlan
    const planStages = stages(winning)
    const stats = (
      explain as never as { executionStats: { nReturned: number; totalDocsExamined: number } }
    ).executionStats

    // Real MongoDB may route a range predicate through either a bounded IXSCAN or
    // a COVERED fetch; either way it must NOT scan the whole collection.
    expect(planStages).toContain('IXSCAN')
    expect(planStages).not.toContain('COLLSCAN')
    // June is ~30 of ~180 days ⇒ roughly a sixth of the rows, never all 10,000.
    expect(stats.totalDocsExamined).toBeLessThan(TOTAL_ROWS / 2)
    expect(stats.nReturned).toBeGreaterThan(0)
    // eslint-disable-next-line no-console
    console.log(
      `[perf] range explain → stages=${planStages.join(',')} returned=${stats.nReturned} docsExamined=${stats.totalDocsExamined}/${TOTAL_ROWS}`
    )
  })

  it('composes every widget over the full ledger within a fast budget', async () => {
    const started = Date.now()
    const m = await buildDashboardMetrics({
      db,
      range: RANGE,
      period: 'month',
      viewable: ALL,
      now: NOW,
    })
    const elapsed = Date.now() - started

    // Sanity that it really computed over the window (non-zero revenue/expense).
    expect(m.blocks.profit!.revenue.paisa).toBeGreaterThan(0)
    expect(m.blocks.expenses!.total.paisa).toBeGreaterThan(0)
    // eslint-disable-next-line no-console
    console.log(`[perf] buildDashboardMetrics over ${TOTAL_ROWS} rows → ${elapsed}ms`)

    // A generous ceiling: this asserts no pathological N+1 / accidental full
    // re-scan, not a micro-optimised target. Free-tier Mongo is slower than prod.
    expect(elapsed).toBeLessThan(5_000)
  })
})
