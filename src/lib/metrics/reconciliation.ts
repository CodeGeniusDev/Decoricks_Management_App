import type { Db } from 'mongodb'
import {
  computeAccountBalances,
  isWithin,
  transactionEffect,
  type DateRange,
  type LedgerEntryLike,
} from '@/lib/finance'
import { computeProfitLoss, PL_CATEGORY_PURCHASING, PL_CATEGORY_REFUNDS } from '@/lib/profit-loss'
import { computeCashFlow } from '@/lib/cash-flow'
import { periodCogsInput } from '@/lib/cogs-service'
import { fetchLedgerRange } from '@/lib/distribution-service'
import { loadAccounts } from '@/lib/finance-ledger'
import { buildStockSummary } from '@/lib/stock-summary'
import { computeBudgetActuals } from '@/lib/budget-actuals'
import { loadBudgetThresholds } from '@/lib/budget-queries'
import { getBudgetCollection } from '@/lib/models/Operations'

/**
 * Phase 8 reconciliation (METRICS.md §H.2) — Founder-only.
 *
 * The brief is explicit: never hide a mismatch. Every check below recomputes a
 * figure a SECOND, independent way (a plain reduce over `transactionEffect`, a
 * sum of the item rows, an accounting identity) and compares it to what the
 * shared engine reported on the primary dashboard path. Because the dashboard and
 * the reports call the same engine, an engine-internal identity or an
 * engine-vs-recompute disagreement is exactly what this surfaces.
 *
 * A difference of any non-zero paisa is a FAIL. Nothing is rounded away, clamped,
 * or auto-corrected.
 */

export interface ReconciliationCheck {
  name: string
  /** Human description of the two sides being compared. */
  description: string
  /** Side A in paisa. */
  a: number
  /** Side B in paisa. */
  b: number
  /** a − b in paisa; the exposed discrepancy. */
  difference: number
  pass: boolean
}

export interface ReconciliationReport {
  range: { start: string; end: string }
  generatedAt: string
  checks: ReconciliationCheck[]
  /** True only when EVERY check passes. */
  allPass: boolean
}

const RESERVE = new Set([PL_CATEGORY_REFUNDS, PL_CATEGORY_PURCHASING])

const check = (name: string, description: string, a: number, b: number): ReconciliationCheck => ({
  name,
  description,
  a,
  b,
  difference: a - b,
  pass: a === b,
})

export async function reconcile(
  db: Db,
  range: DateRange,
  now: Date
): Promise<ReconciliationReport> {
  const historyEnd = new Date(Math.max(now.getTime(), range.end.getTime()))
  const ledger = await fetchLedgerRange(db, { start: new Date(0), end: historyEnd })
  const inRange = ledger.filter((e) => isWithin(new Date(e.date), range))
  const before = ledger.filter((e) => new Date(e.date).getTime() < range.start.getTime())

  // Primary path: exactly what the dashboard / reports render.
  const cogs = await periodCogsInput(db, range)
  const pl = computeProfitLoss(inRange, { cogs })

  // Independent reduces over the same signed effects — no engine reused.
  const sumEffect = (
    entries: LedgerEntryLike[],
    pick: (e: LedgerEntryLike, effect: ReturnType<typeof transactionEffect>) => number
  ) => entries.reduce((total, e) => total + pick(e, transactionEffect(e)), 0)

  const revenueRecompute = sumEffect(inRange, (e, fx) => (e.type === 'income' ? fx.revenue : 0))
  const refundsRecompute = sumEffect(inRange, (e, fx) =>
    e.type === 'expense' && e.category === PL_CATEGORY_REFUNDS ? fx.expense : 0
  )
  const operatingRecompute = sumEffect(inRange, (e, fx) =>
    e.type === 'expense' && e.category && !RESERVE.has(e.category) ? fx.expense : 0
  )

  const checks: ReconciliationCheck[] = [
    check(
      'revenue = Σ income effects',
      'Dashboard/reports revenue (computeProfitLoss) vs an independent income reduce',
      pl.revenue,
      revenueRecompute
    ),
    check(
      'net sales = revenue − refunds',
      'Engine net sales vs revenue minus an independent refunds reduce',
      pl.netSales,
      pl.revenue - refundsRecompute
    ),
    check(
      'operating expenses = Σ non-reserved expense effects',
      'Engine operatingExpenses vs an independent per-category reduce',
      pl.operatingExpenses,
      operatingRecompute
    ),
    check(
      'gross profit = net sales − COGS',
      'Engine grossProfit vs the §5.4 identity over its own components',
      pl.grossProfit,
      pl.netSales - pl.cogs
    ),
    check(
      'net profit = gross profit − operating expenses',
      'Engine netProfit vs the §5.5 identity over its own components',
      pl.netProfit,
      pl.grossProfit - pl.operatingExpenses
    ),
  ]

  // ---- Cash: per-account balances vs the ledger deltas, and the flow identity ----
  const accounts = await loadAccounts(db)
  const accountHistory = accounts.map((a) => ({
    _id: a._id!.toString(),
    name: a.name,
    kind: a.kind,
    isActive: a.isActive,
    openingBalance: a.openingBalance,
  }))
  const flow = computeCashFlow(accountHistory, before, inRange)
  checks.push(
    check(
      'cash: balanceEnd = balanceStart + cashIn − cashOut',
      'Cash-flow identity across every account',
      flow.totalBalanceEnd,
      flow.totalBalanceStart + flow.cashIn - flow.cashOut
    )
  )

  // Balances the dashboard can actually SHOW (only configured accounts) vs every
  // paisa the ledger moved. `computeAccountBalances` keys a running total for ANY
  // accountId it meets, but the dashboard cash block lists only the accounts in
  // `accountHistory` — so money posted to an account that no longer exists would
  // be invisible on screen while still sitting in the ledger. Comparing the two
  // sets is what turns "account balances equal the ledger" into a real check that
  // surfaces an orphaned amount instead of agreeing with itself on both sides.
  const balances = computeAccountBalances(accountHistory, ledger)
  const displayedTotal = accountHistory.reduce((sum, a) => sum + (balances[a._id] ?? 0), 0)
  const openingTotal = accountHistory.reduce((sum, a) => sum + a.openingBalance, 0)
  const deltasTotal = ledger.reduce((sum, e) => {
    const fx = transactionEffect(e)
    return sum + Object.values(fx.accountDeltas).reduce((s, d) => s + d, 0)
  }, 0)
  checks.push(
    check(
      'balances = opening + Σ all account deltas',
      'Σ DISPLAYED account balances vs opening balances plus EVERY ledger delta (catches money outside the account set)',
      displayedTotal,
      openingTotal + deltasTotal
    )
  )

  // ---- Inventory: reported total vs the sum of its own item rows ----
  const stock = await buildStockSummary(db)
  const itemsTotal = stock.items.reduce((sum, item) => sum + item.valuation, 0)
  const locationsTotal = stock.totals.byLocation.reduce((sum, loc) => sum + loc.valuation, 0)
  checks.push(
    check(
      'inventory valuation = Σ product valuations',
      'Reported total stock value vs the sum of the per-product WAC lines',
      stock.totals.totalValuation,
      itemsTotal
    ),
    check(
      'inventory valuation = Σ location valuations',
      'Reported total stock value vs the sum of the by-location rollup',
      stock.totals.totalValuation,
      locationsTotal
    )
  )

  // ---- Budget actual vs the ledger expense slice for the same category ----
  const budgets = await getBudgetCollection(db)
    .find({
      status: 'active',
      periodStart: { $lte: range.end },
      periodEnd: { $gte: range.start },
    } as never)
    .sort({ periodStart: -1 })
    .limit(1)
    .toArray()
  if (budgets.length > 0) {
    const thresholds = await loadBudgetThresholds(db)
    const budget = budgets[0]
    const actuals = computeBudgetActuals(
      {
        categories: budget.categories,
        periodStart: budget.periodStart,
        periodEnd: budget.periodEnd,
      },
      ledger,
      thresholds
    )
    // Independent reduce over the budget's own categories in its own period.
    const bStart = new Date(budget.periodStart)
    const bEnd = new Date(budget.periodEnd)
    const catSet = new Set(budget.categories.map((c) => c.category))
    const actualRecompute = sumEffect(ledger, (e, fx) =>
      e.type === 'expense' && e.category && catSet.has(e.category) && isDayIn(e, bStart, bEnd)
        ? fx.expense
        : 0
    )
    checks.push(
      check(
        'budget actual = Σ ledger expenses in period',
        `Active budget "${budget.name}" totalActual vs an independent expense reduce`,
        actuals.totalActual,
        actualRecompute
      )
    )
  }

  return {
    range: { start: range.start.toISOString(), end: range.end.toISOString() },
    generatedAt: now.toISOString(),
    checks,
    allPass: checks.every((c) => c.pass),
  }
}

/**
 * Day-boundary membership for the budget-period recompute, matching
 * `budgetPeriodRange` semantics (inclusive of the end day's Karachi evening)
 * without importing the range builder — a deliberately independent expansion so
 * the check does not simply re-run the code under test.
 */
function isDayIn(entry: LedgerEntryLike, startDay: Date, endDay: Date): boolean {
  const day = new Date(entry.date)
  // Compare on the day granularity: the budget stores period days as midnights.
  return day.getTime() >= startDay.getTime() && day.getTime() <= endDay.getTime() + 86_400_000 - 1
}
