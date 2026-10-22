/**
 * Read-only financial integrity verifier (Phase 5 §1/§5).
 *
 * The automated suites prove the finance engine's arithmetic against synthetic
 * ledgers. They cannot prove that the *stored* records in a real database still
 * satisfy it: a ledger row edited after a distribution was approved, a budget
 * whose category totals drifted, or a reversal left half-linked all read as
 * plausible numbers on screen.
 *
 * So this script re-runs the application's own maths against the documents as
 * they are stored, and prints the collection sizes it examined first. A check
 * over one row is a check over one row; the counts are part of the result, not
 * a footnote, because "the figures match the transactions" is only as strong as
 * the data it was said about.
 *
 * It performs no writes. Usage:
 *   npx tsx scripts/verify-finance.ts                 # application database
 *   MONGODB_DB=decoricks_test npx tsx scripts/verify-finance.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MongoClient, type Db, type Document } from 'mongodb'
import { getEnv } from '../src/lib/env'
import { resolveDatabase } from '../src/lib/db-name'
import {
  SINGLE_ACCOUNT_TYPES,
  computeAccountBalances,
  summarize,
  type LedgerEntryStatus,
  type LedgerEntryType,
} from '../src/lib/finance'
import { normalizeEntry } from '../src/lib/finance-ledger'
import { computeProfitLoss } from '../src/lib/profit-loss'
import {
  getAccountCollection,
  getFinanceCategoryCollection,
  getLedgerCollection,
  type Account,
  type FinanceCategory,
  type LedgerTransaction,
} from '../src/lib/models/Ledger'
import { getBudgetCollection, type Budget } from '../src/lib/models/Operations'
import {
  getProfitDistributionCollection,
  type ProfitDistribution,
} from '../src/lib/models/Distribution'
import {
  buildDistribution,
  karachiMonthRangeForMonth,
  recomputeShares,
} from '../src/lib/distribution-service'

/** `tsx` does not read `.env.local`; the application's scripts all do it here. */
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

const ENTRY_TYPES: LedgerEntryType[] = [
  'income',
  'expense',
  'transfer',
  'partner_capital',
  'partner_withdrawal',
  'reinvestment',
]

let errors = 0
let warnings = 0

const fail = (check: string, detail: string): void => {
  errors += 1
  console.log(`  FAIL  ${check}: ${detail}`)
}
const warn = (check: string, detail: string): void => {
  warnings += 1
  console.log(`  WARN  ${check}: ${detail}`)
}
const pass = (check: string, detail: string): void => console.log(`  ok    ${check}: ${detail}`)

/** Distinct paisa amount, no rounding: every stored figure is integer paisa. */
const isPaisa = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const verifyLedger = async (db: Db, categories: FinanceCategory[], accounts: Account[]) => {
  const entries = await getLedgerCollection(db).find({}).sort({ date: 1 }).toArray()
  console.log(`\n-- ledger (${entries.length} rows) --`)

  const accountIds = new Set(accounts.map((a) => String(a._id)))
  const categoryNames = new Set(categories.map((c) => c.name))
  const seenKeys = new Map<string, string>()
  const exactDupes = new Map<string, number>()
  const broken: string[] = []

  let reversalNet = 0
  const paired = new Map<string, LedgerTransaction>()

  for (const e of entries) {
    const ref = `${String(e._id)} (${e.type} ${e.amount})`

    if (!ENTRY_TYPES.includes(e.type)) broken.push(`${ref} unknown type "${e.type}"`)
    if (!['posted', 'reversed'].includes(e.status as LedgerEntryStatus)) {
      broken.push(`${ref} unknown status "${String(e.status)}"`)
    }
    if (!isPaisa(e.amount)) broken.push(`${ref} amount is not positive integer paisa`)
    if (!(e.date instanceof Date)) broken.push(`${ref} date is not a Date`)

    // Shape by type: a single-account entry needs `accountId`, a transfer needs
    // both legs and must not move money into itself.
    if (SINGLE_ACCOUNT_TYPES.has(e.type) && !e.accountId) broken.push(`${ref} missing accountId`)
    if (e.type === 'transfer' && (!e.fromAccountId || !e.toAccountId)) {
      broken.push(`${ref} transfer missing a leg`)
    }
    if (e.type === 'transfer' && e.fromAccountId && e.fromAccountId.equals(e.toAccountId)) {
      broken.push(`${ref} transfer in and out of the same account`)
    }
    for (const id of [e.accountId, e.fromAccountId, e.toAccountId]) {
      if (id && !accountIds.has(String(id))) broken.push(`${ref} references unknown account ${id}`)
    }
    if (e.category && !categoryNames.has(e.category)) {
      warn('category', `${ref} uses "${e.category}", which is not in financeCategories`)
    }

    /*
     * The Phase 5 idempotency defect left its shape in the data: a keyless
     * write that stored `idempotencyKey: null` occupies the unique sparse index
     * slot that should stay empty. Any row found here means a build still
     * serialises `undefined` into `null`.
     */
    if ('idempotencyKey' in e && e.idempotencyKey === null) {
      broken.push(`${ref} stores idempotencyKey as null (poisons the sparse unique index)`)
    }
    if (typeof e.idempotencyKey === 'string') {
      const first = seenKeys.get(e.idempotencyKey)
      if (first) broken.push(`${ref} reuses idempotencyKey first seen on ${first}`)
      else seenKeys.set(e.idempotencyKey, ref)
    }

    const dupeKey = [
      e.type,
      e.amount,
      e.date?.toISOString(),
      String(e.accountId ?? ''),
      e.category ?? '',
      e.note ?? '',
    ].join('|')
    exactDupes.set(dupeKey, (exactDupes.get(dupeKey) ?? 0) + 1)

    // Reversals must cancel their original to exactly zero.
    if (e.isReversal) {
      if (!e.reversesId) broken.push(`${ref} isReversal without reversesId`)
      if (e.reversedBy) broken.push(`${ref} is itself reversed by ${e.reversedBy}`)
      reversalNet += e.amount
      if (e.reversesId) paired.set(String(e.reversesId), e)
    } else if (e.reversedBy) {
      reversalNet -= e.amount
    }
  }

  if (broken.length === 0) pass('row shape', `${entries.length} rows valid`)
  else broken.forEach((message) => fail('row shape', message))

  const doubles = [...exactDupes.entries()].filter(([, n]) => n > 1)
  if (doubles.length === 0) pass('duplicates', 'no identical rows')
  else
    doubles.forEach(([k, n]) =>
      warn('duplicates', `${n} identical rows [${k}] — check for a double submit`)
    )

  if (entries.length === 0 || paired.size === 0) {
    warn('reversals', 'no reversal pairs in this data — this proves nothing')
  } else if (reversalNet !== 0) {
    fail('reversals', `reversed pairs do not net to zero (off by ${reversalNet} paisa)`)
  } else {
    for (const [originalId, reversal] of paired) {
      const original = entries.find((e) => String(e._id) === originalId)
      if (!original) fail('reversals', `reversal ${reversal._id} points at missing ${originalId}`)
      else if (original.amount !== reversal.amount) {
        fail(
          'reversals',
          `${originalId} reversed for ${reversal.amount}, original was ${original.amount}`
        )
      }
    }
    pass('reversals', `${paired.size} reversed pair(s) net to zero`)
  }

  // `LedgerEntryLike` keys entries by string id, which is how the engine
  // correlates account deltas; the driver's documents carry an ObjectId.
  const normalized = entries.map(normalizeEntry)

  const totals = summarize(normalized)
  pass(
    'aggregates',
    `revenue ${totals.revenue} − expense ${totals.expense} = net ${totals.netProfit} paisa`
  )

  const balances = computeAccountBalances(
    accounts.map((a) => ({
      _id: String(a._id),
      openingBalance: a.openingBalance,
      isActive: a.isActive,
    })),
    normalized
  )
  const negative = Object.entries(balances).filter(([, b]) => b < 0)
  if (negative.length === 0) pass('balances', 'no account overdrawn')
  else
    negative.forEach(([id, b]) => warn('balances', `account ${id} balance ${b} paisa is negative`))
}

const verifyBudgets = async (db: Db, categories: FinanceCategory[]) => {
  const budgets = await getBudgetCollection(db).find({}).toArray()
  console.log(`\n-- budgets (${budgets.length} rows) --`)
  if (budgets.length === 0) return warn('budgets', 'no rows to check — this proves nothing')

  const categoryNames = new Set(categories.map((c) => c.name))
  for (const b of budgets) verifyBudget(b, categoryNames)
  if (!errors) pass('budgets', 'totalBudgeted equals the sum of its categories')
}

const verifyBudget = (b: Budget, categoryNames: Set<string>): void => {
  const ref = `${String(b._id)} (${b.name})`
  const sum = b.categories.reduce((acc, c) => acc + c.budgeted, 0)
  if (sum !== b.totalBudgeted)
    fail('budget total', `${ref} categories sum ${sum} but totalBudgeted ${b.totalBudgeted}`)
  if (b.periodStart > b.periodEnd) fail('budget period', `${ref} ends before it starts`)
  const unknown = b.categories.map((c) => c.category).filter((name) => !categoryNames.has(name))
  if (unknown.length)
    warn('budget category', `${ref} budgets unknown categories: ${unknown.join(', ')}`)
  if (new Set(b.categories.map((c) => c.category)).size !== b.categories.length) {
    fail('budget category', `${ref} lists the same category twice — the total would double-count`)
  }
  if ('idempotencyKey' in b && (b as Document).idempotencyKey === null) {
    fail('budget idempotency', `${ref} stores idempotencyKey as null`)
  }
}

const verifyDistributions = async (db: Db) => {
  const stored = await getProfitDistributionCollection(db).find({}).toArray()
  console.log(`\n-- profit distributions (${stored.length} rows) --`)
  if (stored.length === 0) return warn('distributions', 'no rows to check — this proves nothing')

  for (const doc of stored) await verifyDistribution(db, doc)
}

const verifyDistribution = async (db: Db, doc: ProfitDistribution): Promise<void> => {
  const ref = `${String(doc._id)} (${doc.month})`

  // 1. The split must account for every paisa of the stored net profit.
  const partners = doc.partnerShares.reduce((acc, s) => acc + s.finalAmount, 0)
  const accounted = partners + doc.charityShare.amount + doc.retainedEarnings
  if (accounted !== doc.netProfit) {
    fail(
      'split balance',
      `${ref} partners ${partners} + charity ${doc.charityShare.amount} + retained ${doc.retainedEarnings} = ${accounted}, netProfit ${doc.netProfit}`
    )
  } else {
    pass('split balance', `${ref} accounts for all ${doc.netProfit} paisa`)
  }

  // 2. The P&L chain must be internally consistent.
  const chain: string[] = []
  if (doc.netSales !== doc.totalRevenue - doc.refunds) {
    chain.push(`netSales ${doc.netSales} ≠ revenue ${doc.totalRevenue} − refunds ${doc.refunds}`)
  }
  if (doc.grossProfit !== doc.netSales - doc.cogs) {
    chain.push(`grossProfit ${doc.grossProfit} ≠ netSales ${doc.netSales} − cogs ${doc.cogs}`)
  }
  if (doc.netProfit !== doc.grossProfit - doc.operatingExpenses) {
    chain.push(
      `netProfit ${doc.netProfit} ≠ grossProfit ${doc.grossProfit} − opex ${doc.operatingExpenses}`
    )
  }
  if (chain.length === 0)
    pass('p&l chain', `${ref} revenue → netSales → grossProfit → netProfit recomputes`)
  else chain.forEach((message) => fail('p&l chain', `${ref} ${message}`))

  // 3. The frozen split must re-derive from the frozen inputs. `recomputeShares`
  //    is the exact function the adjust/approve routes use, so a mismatch means
  //    the stored arithmetic cannot be reproduced by anyone, ever.
  const expected = recomputeShares(doc)
  const shareDrift = doc.partnerShares
    .map((share, index) => {
      const again = expected[index]
      if (!again) return `${share.partnerName}: no recomputed share at index ${index}`
      const fields = [
        'shareAmount',
        'reinvestedAmount',
        'finalAmount',
        'availableToWithdraw',
      ] as const
      const diff = fields
        .filter((field) => share[field] !== again[field])
        .map((field) => `${field} stored ${share[field]} vs ${again[field]}`)
      return diff.length ? `${share.partnerName}: ${diff.join(', ')}` : null
    })
    .filter((message): message is string => message !== null)
  if (shareDrift.length === 0)
    pass('split re-derives', `${ref} partner shares equal the engine run over the stored snapshot`)
  else shareDrift.forEach((message) => fail('split re-derives', `${ref} ${message}`))

  /*
   * 4. The P&L must still equal the ledger rows that existed when the snapshot
   *    was taken, holding the snapshot's own COGS input constant.
   *
   * Rows written after `createdAt` are excluded on purpose: an approved
   * distribution is a frozen record (SPEC §5.9), so later activity in the same
   * month is history, not corruption — it is reported as information. What this
   * check cannot excuse is a row that was *already there* and then changed: an
   * edit to a posted entry, or a deletion. Those shift the ground under a
   * number that has already been paid out against.
   */
  const range = karachiMonthRangeForMonth(doc.month)
  if (!range)
    return fail('recompute', `${ref} month "${doc.month}" did not resolve to a Karachi period`)

  const inPeriod = await getLedgerCollection(db)
    .find({ date: { $gte: range.start, $lte: range.end } })
    .toArray()
  const atSnapshot = inPeriod.filter((e) => e.createdAt <= doc.createdAt)
  const later = inPeriod.length - atSnapshot.length

  const pl = computeProfitLoss(atSnapshot.map(normalizeEntry), {
    cogs: { amount: doc.cogs, provisional: doc.cogsProvisional, source: 'stored snapshot' },
  })

  const drift = (
    [
      ['totalRevenue', pl.revenue],
      ['refunds', pl.refunds],
      ['netSales', pl.netSales],
      ['grossProfit', pl.grossProfit],
      ['operatingExpenses', pl.operatingExpenses],
      ['netProfit', pl.netProfit],
    ] as const
  )
    .map(([field, now]) =>
      now === doc[field]
        ? null
        : `${field}: stored ${doc[field]} vs ${now} from the rows present at approval`
    )
    .filter((message): message is string => message !== null)

  if (drift.length === 0) {
    pass(
      'recompute',
      `${ref} equals its own ledger as it stood at approval (${atSnapshot.length} rows in period)`
    )
  } else {
    drift.forEach((message) => fail('recompute', `${ref} ${message}`))
  }

  if (later > 0) {
    const fresh = await buildDistribution(db, doc.month)
    warn(
      'frozen snapshot',
      `${ref}: ${later} row(s) were written into this period after it was taken, so the record no longer matches the ledger as it stands today` +
        (fresh ? ` — a new run for ${doc.month} would book netProfit ${fresh.netProfit}` : '') +
        '. Expected history for an approved month; review a draft that was never approved.'
    )
  }

  // A period whose money was un-spent after the run is worth an operator's eye:
  // the distribution still pays out against income that has since been reversed.
  const reversedAfter = inPeriod.filter(
    (e) => (e.isReversal || e.reversedBy) && e.createdAt > doc.createdAt
  )
  if (reversedAfter.length > 0) {
    warn(
      'late reversals',
      `${ref}: ${reversedAfter.length} row(s) in this period were reversed after the snapshot — the paid-out figures describe money that has partly moved back`
    )
  }
}

const main = async (): Promise<void> => {
  const env = getEnv()
  const target = resolveDatabase(env)
  const client = new MongoClient(env.MONGODB_URI)

  try {
    await client.connect()
    const db = client.db(target.dbName)
    console.log(
      `Database: "${db.databaseName}" (resolved from ${target.source}) — read-only checks`
    )

    const [accounts, categories] = await Promise.all([
      getAccountCollection(db).find({}).toArray(),
      getFinanceCategoryCollection(db).find({}).toArray(),
    ])
    console.log(`Configuration: ${accounts.length} accounts, ${categories.length} categories`)

    await verifyLedger(db, categories, accounts)
    await verifyBudgets(db, categories)
    await verifyDistributions(db)

    console.log(`\n${errors} failing, ${warnings} advisory over the rows listed above.`)
    if (errors > 0) process.exit(1)
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error('Verification failed:', error)
  process.exit(1)
})
