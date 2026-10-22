/**
 * Database-side latency probe (Phase 4 §1).
 *
 * The HTTP probe (`perf-probe.ts`) measures what the browser waits for. This one
 * measures what the server waits for, by timing the individual read primitives
 * the aggregate endpoints compose. The distinction matters for choosing a fix:
 * a slow endpoint made of one expensive query needs a query change, while a slow
 * endpoint made of many cheap sequential queries needs concurrency instead.
 *
 * `--serial` replays the dashboard's finance branch exactly as the code does it
 * today (one await after another); `--parallel` replays the same work fanned
 * out, so the speed-up is measured rather than asserted.
 *
 * Usage: E2E_TEST_MODE=1 MONGODB_TEST_DB=decoricks_test npx tsx scripts/db-probe.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// Same reader scripts/seed.ts uses, so a standalone tsx run gets the real env.
const loadEnvLocal = (): void => {
  const file = path.join(process.cwd(), '.env.local')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    const value = match[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    if (process.env[match[1]] === undefined) process.env[match[1]] = value
  }
}
loadEnvLocal()

const time = async (label: string, fn: () => Promise<unknown>, n = 3): Promise<number> => {
  const runs: number[] = []
  let bytes = 0
  for (let i = 0; i < n; i += 1) {
    const t = Date.now()
    const res = await fn()
    runs.push(Date.now() - t)
    try {
      bytes = JSON.stringify(res)?.length ?? 0
    } catch {
      bytes = -1
    }
  }
  console.log(
    `${label.padEnd(28)} ${runs.join(' / ')}ms   ` +
      `${bytes >= 0 ? `${Math.round(bytes / 1024)} KB json` : 'unserialisable'}`
  )
  return runs[0]
}

async function main(): Promise<void> {
  const { getDatabase } = await import('@/lib/mongodb')
  const { fetchLedgerRange } = await import('@/lib/distribution-service')
  const { loadAccounts } = await import('@/lib/finance-ledger')
  const { periodCogsInput } = await import('@/lib/cogs-service')
  const { buildStockSummary } = await import('@/lib/stock-summary')
  const { isWithin } = await import('@/lib/finance')
  const { computeProfitLoss } = await import('@/lib/profit-loss')
  const { monthsInRange } = await import('@/lib/metrics/trend')

  const db = await getDatabase()
  const now = new Date()
  const range = { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now }

  const names = [
    'transactions',
    'stockMovements',
    'products',
    'orders',
    'returns',
    'tasks',
    'taskDocs',
    'sessions',
    'users',
    'budgets',
    'accounts',
  ]
  for (const n of names) {
    const c = db.collection(n)
    const count = await c.countDocuments()
    if (count) console.log(`  ${n.padEnd(18)} ${count} docs`)
  }

  console.log('\n-- individual primitives --')
  await time('fetchLedgerRange(all)', () => fetchLedgerRange(db, { start: new Date(0), end: now }))
  await time('loadAccounts', () => loadAccounts(db))
  await time('periodCogsInput(month)', () => periodCogsInput(db, range))
  await time('buildStockSummary', () => buildStockSummary(db))

  const windows = monthsInRange(range)
  await time('cogs x month windows', () =>
    Promise.all(windows.map((m) => periodCogsInput(db, m.range)))
  )

  console.log('\n-- dashboard finance branch, as written today (serial) --')
  const serialStart = Date.now()
  const ledger = await fetchLedgerRange(db, { start: new Date(0), end: now })
  const inRange = ledger.filter((e) => isWithin(new Date(e.date), range))
  const cogs = await periodCogsInput(db, range)
  computeProfitLoss(inRange, { cogs })
  const settingsCol = await db.collection('businessSettings').findOne({ key: 'business' })
  const accounts = await loadAccounts(db)
  const summary = await buildStockSummary(db)
  console.log(
    `  serial total ${Date.now() - serialStart}ms  (${settingsCol ? 'policy read' : 'no policy'}, ${accounts.length} accounts, ${summary.totals.lowStockCount} low stock)`
  )

  console.log('\n-- the same reads fanned out, repeated (pool warm-up) --')
  for (let i = 0; i < 4; i += 1) {
    const parStart = Date.now()
    const [ledger2, cogs2, accounts2, summary2] = await Promise.all([
      fetchLedgerRange(db, { start: new Date(0), end: now }),
      periodCogsInput(db, range),
      loadAccounts(db),
      buildStockSummary(db),
    ])
    await db.collection('businessSettings').findOne({ key: 'business' })
    computeProfitLoss(
      ledger2.filter((e) => isWithin(new Date(e.date), range)),
      { cogs: cogs2 }
    )
    console.log(
      `  run ${i + 1}: ${Date.now() - parStart}ms  (${accounts2.length} accounts, ${summary2.totals.lowStockCount} low stock)`
    )
  }

  // The single-round-trip primitive, timed while the pool is known-warm. Any
  // extra in the very first reading above is connection setup, not query work.
  console.log('\n-- one indexed point read, back to back --')
  await time('session lookup (auth path)', () =>
    db.collection('sessions').findOne({ tokenHash: 'not-a-real-hash' })
  )

  /*
   * Is a whole-collection read one round trip or several? The driver returns
   * the first batch of a `find` at ~101 documents and needs a `getMore` per
   * batch after that, so a 400-entry ledger can cost 4 times the network of a
   * 100-entry one even though the query work is trivial. Reading the ledger is
   * the most expensive stage in the finance endpoints (257-264ms for
   * `q:ledger:all`), so this distinguishes "shrink the payload / bound the read"
   * from "add an index" — the two fixes have nothing in common. The sort in use
   * is already covered by the `transactions_date` index ({ date: -1,
   * createdAt: -1 }), so an in-memory sort is not the explanation either.
   */
  console.log('\n-- cursor batching: how the ledger read scales --')
  const total = await db.collection('transactions').countDocuments()
  console.log(`  transactions: ${total} docs`)
  for (const n of [1, 100, 101, 202, 404, total]) {
    await time(`find().limit(${n})`, () =>
      db.collection('transactions').find({}).limit(n).toArray()
    )
  }
  await time('find() sorted, no limit', () =>
    db.collection('transactions').find({}).sort({ date: -1, createdAt: -1 }).toArray()
  )
  await time('find() with a projection', () =>
    db
      .collection('transactions')
      .find({})
      .project({ date: 1, type: 1, amount: 1, accountId: 1, category: 1, createdAt: 1 })
      .sort({ date: -1, createdAt: -1 })
      .toArray()
  )
  /*
   * The lever the two readings above point at. A `find` returns its first batch
   * of 101 documents and then needs one network round trip per batch; asking for
   * a larger first batch trades those round trips for one. The 16 MB BSON cap is
   * the real ceiling on the batch, not this number, so a projection staying in
   * the same reading is the check that this is about trips and not bytes.
   */
  await time('find() batchSize(1000)', () =>
    db
      .collection('transactions')
      .find({})
      .batchSize(1000)
      .sort({ date: -1, createdAt: -1 })
      .toArray()
  )

  process.exit(0)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
