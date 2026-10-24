import type { Db } from 'mongodb'
import { ObjectId } from 'mongodb'

import {
  computeAccountBalances,
  computeAverages,
  isWithin,
  karachiDayCount,
  type DateRange,
} from '@/lib/finance'
import { computeProfitLoss } from '@/lib/profit-loss'
import type { CogsInput } from '@/lib/profit-loss'
import { monthlyProfitSeries, type MonthlyPlPoint } from '@/lib/profit-loss'
import {
  buildSalesExpenseSeries,
  monthsInRange,
  pickGranularity,
  type TrendGranularity,
  type TrendPoint,
} from '@/lib/metrics/trend'
import { computeCashFlow, type CashFlow, type ReportPeriod } from '@/lib/cash-flow'
import { cogsInputsForRanges } from '@/lib/cogs-service'
import { fetchLedgerRange } from '@/lib/distribution-service'
import { loadAccounts } from '@/lib/finance-ledger'
import { buildStockSummary } from '@/lib/stock-summary'
import { computeBudgetActuals, type BudgetActuals } from '@/lib/budget-actuals'
import { loadBudgetThresholds } from '@/lib/budget-queries'
import { resolveBusinessPolicy } from '@/lib/business-policy'
import { timeStage } from '@/lib/timing'
import { LOCATION_LABELS } from '@/lib/stock-math'
import { formatPaisa } from '@/lib/money'
import { getBusinessSettingsCollection } from '@/lib/models/Ledger'
import { getBudgetCollection } from '@/lib/models/Operations'
import { getOrderCollection, getReturnCollection } from '@/lib/models/Sales'
import { getColumnCollection, getTaskDocCollection } from '@/lib/models/Tasks'
import { getUserCollection, type PermissionModule } from '@/lib/models/User'
import { advertisingSpend, expenseByCategory, sumOperatingExpenses } from '@/lib/metrics/selectors'

/**
 * Phase 8 dashboard composition (Checkpoint 1 — METRICS.md is the contract).
 *
 * This module does NOT contain a single financial formula. Every figure is
 * produced by the Phase 1–7 engines it calls:
 *
 *   computeProfitLoss  → revenue, net sales, COGS, gross & net profit, expenses
 *   cogsInputsForRanges → movement-based COGS fed into the P&L above
 *   computeCashFlow    → cash in / out / per-account positions
 *   computeAccountBalances → current cash balance by account
 *   buildStockSummary  → WAC inventory value by location + low stock
 *   computeBudgetActuals → budget vs actual (self-filtered to the budget period)
 *   computeAverages    → daily / weekly / monthly rates
 *
 * The only arithmetic here is (a) reading the ledger once and slicing it, and
 * (b) the documented `netProfit ÷ karachiDayCount` profit average (METRICS §G),
 * whose numerator is the engine's net profit — never a re-derived figure.
 *
 * Server-side authorization is honoured by SHAPE: each block is present only when
 * its owning module's `view` grant is in `viewable`. A block the caller cannot
 * view is never assembled, so its numbers never reach the response — enforcement,
 * not hiding.
 */

export interface MoneyValue {
  /** Integer paisa, the engine value. */
  paisa: number
  /** Formatted for display only; never re-summed. */
  display: string
}

const money = (paisa: number): MoneyValue => ({ paisa, display: formatPaisa(paisa) })

export interface DashboardInput {
  db: Db
  range: DateRange
  period: ReportPeriod
  /** The subset of modules the caller may view (from `resolveViewScopes`). */
  viewable: PermissionModule[]
  /** "Now" — the reporting instant; balances and overdue are measured against it. */
  now: Date
}

export interface ProfitBlock {
  revenue: MoneyValue
  revenueCount: number
  netSales: MoneyValue
  refunds: MoneyValue
  cogs: MoneyValue
  cogsProvisional: boolean
  cogsSource: string
  grossProfit: MoneyValue
  operatingExpenses: MoneyValue
  netProfit: MoneyValue
  /** METRICS §G: engine net profit over the range's calendar days (rounded once). */
  netProfitPerDay: MoneyValue
}

export interface ExpenseBlock {
  total: MoneyValue
  advertising: MoneyValue
  /** The resolved advertising category slugs, shown so the split is auditable. */
  advertisingCategories: string[]
  byCategory: { category: string; amount: MoneyValue }[]
}

export interface CashBlock {
  cashIn: MoneyValue
  cashOut: MoneyValue
  netCashFlow: MoneyValue
  revenueIn: MoneyValue
  operatingOut: MoneyValue
  capitalIn: MoneyValue
  withdrawalsOut: MoneyValue
  transferCount: number
  totalBalanceStart: MoneyValue
  totalBalanceEnd: MoneyValue
  /** Current point-in-time balance per account, labelled "as of" `generatedAt`. */
  accounts: {
    accountId: string
    name: string
    kind: string
    balance: MoneyValue
  }[]
}

export interface InventoryBlock {
  totalValue: MoneyValue
  lowStockCount: number
  byLocation: { location: string; label: string; value: MoneyValue }[]
}

export interface OrdersBlock {
  count: number
  /** METRICS §A.2: booked merchandise value, NOT ledger revenue. Kept separate. */
  grossOrderValue: MoneyValue
  byStatus: Record<string, number>
  cancellations: number
  returns: { count: number; refundAmount: MoneyValue }
}

export interface BudgetBlock {
  id: string
  name: string
  periodStart: string
  periodEnd: string
  actuals: BudgetActuals
}

export interface TasksBlock {
  completed: number
  completedByMember: { name: string; count: number }[]
  overdue: number
  overdueByMember: { name: string; count: number }[]
}

export interface AveragesBlock {
  days: number
  perDay: MoneyValue
  perWeek: MoneyValue
  perMonth: MoneyValue
  perEntry: MoneyValue
}

/**
 * Chart series (METRICS §K). `salesVsExpenses` buckets revenue/opEx by the
 * granularity that fits the window; `profitTrend` is the existing monthly P&L
 * series (`monthlyProfitSeries`), so the profit chart and the profit headline
 * are the same engine reading the same ledger.
 */
export interface TrendBlock {
  granularity: TrendGranularity
  salesVsExpenses: TrendPoint[]
  profitTrend: MonthlyPlPoint[]
}

export interface DashboardMetrics {
  period: ReportPeriod
  range: { start: string; end: string }
  generatedAt: string
  /** Which modules were granted; the client renders exactly these blocks. */
  viewable: PermissionModule[]
  blocks: {
    profit?: ProfitBlock
    expenses?: ExpenseBlock
    cash?: CashBlock
    inventory?: InventoryBlock
    orders?: OrdersBlock
    budget?: BudgetBlock[]
    tasks?: TasksBlock
    averages?: AveragesBlock
    trend?: TrendBlock
  }
}

const canView = (viewable: Set<PermissionModule>, module: PermissionModule): boolean =>
  viewable.has(module)

export async function buildDashboardMetrics(input: DashboardInput): Promise<DashboardMetrics> {
  const { db, range, period, now } = input
  const viewable = new Set(input.viewable)

  /*
   * The ledger is read ONCE, date-bounded, and sliced in memory for every engine
   * that consumes it. This replaces the old per-widget multiple reads and is the
   * whole money source.
   *
   * It is issued *left in flight* rather than awaited here. Measured on the
   * production build (`API_TIMING=1`, `scripts/api-timing-summary.cjs`):
   *   total=660ms  q:ledger:history=263ms  q:block:inventory=280ms
   *   q:block:tasks=239ms  q:block:orders=156ms  q:block:finance=167ms
   *   q:block:budget=166ms
   * Awaiting it first put 263ms of a single round trip in front of five reads
   * that did not need it: inventory, orders and tasks never touch a ledger row,
   * so they were queueing behind a fetch they would throw away. Only finance and
   * budget await `ledgerPromise`, and they await it *outside* their own
   * `timeStage`, so `q:block:*` keeps reporting each block's own work rather than
   * the shared wait — otherwise every dependent block would look slow and the
   * actual cause (one 263ms read) would be invisible in the breakdown.
   *
   * The ledger read is also the first element of the `Promise.all` below, so its
   * rejection is always observed even when the caller may view neither finance
   * nor budget.
   */
  const historyEnd = new Date(Math.max(now.getTime(), range.end.getTime()))
  const ledgerPromise = timeStage('q:ledger:history', () =>
    fetchLedgerRange(db, { start: new Date(0), end: historyEnd })
  )
  const sliceInRange = (entries: Awaited<typeof ledgerPromise>) =>
    entries.filter((e) => isWithin(new Date(e.date), range))
  const sliceBefore = (entries: Awaited<typeof ledgerPromise>) =>
    entries.filter((e) => new Date(e.date).getTime() < range.start.getTime())

  /*
   * Phase 4 §2 — the five block groups are gated by *different* module
   * permissions and read from *different* collections, so no group depends on
   * another's result. They used to be awaited one after another, and the cost of
   * that is measured rather than assumed (`scripts/db-probe.ts`): one indexed
   * round trip against this cluster is ~65ms of network while the data behind it
   * is trivial (the entire ledger serialises to ~150KB and no individual read in
   * this composition exceeds ~140ms). Sequential the endpoint answered in ~1.3s;
   * the same reads issued concurrently answer in ~0.5s.
   *
   * Two things are deliberately preserved:
   *   - the `canView` gate still decides whether a query is *issued at all*, so a
   *     module the caller cannot view is never read, never assembled and never
   *     reaches the response — enforcement, not hiding;
   *   - every engine still consumes the same `ledgerUpToNow` slice above, so the
   *     figures across blocks stay reconciled.
   * Concurrent reads are not a snapshot guarantee, but neither were the old
   * sequential ones — a write landing between two awaits already produced a mixed
   * board. Fanning out narrows that window instead of widening it.
   *
   * Each group is timed under its own stage name (`q:block:*`) because the names
   * must stay distinct: `timeStage` accumulates a repeated name into one line, so
   * five groups sharing a name would report a summed wall time larger than the
   * request itself and hide which block actually dominates the response.
   */
  // The elided first slot is `ledgerPromise`: kept in the set so a rejection is
  // always observed, even for a caller who may view neither finance nor budget.
  const [, financeBlocks, inventoryBlock, ordersBlock, budgetBlocks, tasksBlock] =
    await Promise.all([
      ledgerPromise,
      canView(viewable, 'finance')
        ? (async () => {
            const ledger = await ledgerPromise
            return timeStage('q:block:finance', () =>
              buildFinanceBlocks({
                db,
                range,
                viewable,
                ledgerUpToNow: ledger,
                entriesInRange: sliceInRange(ledger),
                entriesBefore: sliceBefore(ledger),
              })
            )
          })()
        : Promise.resolve({} as FinanceBlocks),
      canView(viewable, 'inventory')
        ? timeStage('q:block:inventory', () => buildInventoryBlock(db))
        : Promise.resolve(undefined),
      canView(viewable, 'sales')
        ? timeStage('q:block:orders', () => buildOrdersBlock(db, range))
        : Promise.resolve(undefined),
      canView(viewable, 'budget')
        ? (async () => {
            const ledger = await ledgerPromise
            return timeStage('q:block:budget', () => buildBudgetBlocks(db, range, ledger))
          })()
        : Promise.resolve(undefined),
      canView(viewable, 'tasks')
        ? timeStage('q:block:tasks', () => buildTasksBlock(db, range, now))
        : Promise.resolve(undefined),
    ])

  const blocks: DashboardMetrics['blocks'] = {
    ...financeBlocks,
    ...(inventoryBlock ? { inventory: inventoryBlock } : {}),
    ...(ordersBlock ? { orders: ordersBlock } : {}),
    ...(budgetBlocks ? { budget: budgetBlocks } : {}),
    ...(tasksBlock ? { tasks: tasksBlock } : {}),
  }

  return {
    period,
    range: { start: range.start.toISOString(), end: range.end.toISOString() },
    generatedAt: now.toISOString(),
    viewable: input.viewable,
    blocks,
  }
}

type LedgerRow = Awaited<ReturnType<typeof fetchLedgerRange>>[number]

interface FinanceBlocks {
  profit?: ProfitBlock
  expenses?: ExpenseBlock
  cash?: CashBlock
  averages?: AveragesBlock
  trend?: TrendBlock
}

/**
 * Identity for a range, used to collapse duplicates before a batched COGS read.
 * Milliseconds, not ISO strings: two ranges are the same read only when both
 * boundaries are exactly the same instants.
 */
const rangeKey = (r: DateRange) => `${r.start.getTime()}:${r.end.getTime()}`

/**
 * COGS for the headline range and the whole month series in one fetch.
 *
 * Each was previously its own `periodCogsInput` call, and those calls each pay
 * for a guard read plus a movement read. A `month` view therefore asked the
 * cluster twice for the *same* rows — `monthsInRange` clips a one-month range
 * to exactly that range — and a six-month custom view asked seven times.
 * `cogsInputsForRanges` already solves this: one fetch of the union window, each
 * requested range filtered in memory with the same inclusive bounds, the same
 * `cogsFromMovements` reducer and the same "no movement history at all → null"
 * guard. The numbers cannot differ; only the round trips do.
 */
async function cogsForRanges(
  db: Db,
  monthWindows: { range: DateRange }[],
  range: DateRange
): Promise<{ cogs: CogsInput | null; cogsPerMonth: (CogsInput | null)[] }> {
  const unique = new Map<string, DateRange>()
  for (const r of [...monthWindows.map((m) => m.range), range]) {
    unique.set(rangeKey(r), r)
  }
  const list = [...unique.values()]
  const values = await cogsInputsForRanges(db, list)
  const byKey = new Map(list.map((r, i) => [rangeKey(r), values[i] ?? null]))
  return {
    cogs: byKey.get(rangeKey(range)) ?? null,
    cogsPerMonth: monthWindows.map((m) => byKey.get(rangeKey(m.range)) ?? null),
  }
}

/**
 * The finance branch. Identical arithmetic to the sequential version it
 * replaces — only the independent reads (the batched COGS series, business
 * policy, accounts) are issued together instead of in a line.
 */
async function buildFinanceBlocks(args: {
  db: Db
  range: DateRange
  viewable: Set<PermissionModule>
  ledgerUpToNow: LedgerRow[]
  entriesInRange: LedgerRow[]
  entriesBefore: LedgerRow[]
}): Promise<FinanceBlocks> {
  const { db, range, viewable, ledgerUpToNow, entriesInRange, entriesBefore } = args
  const monthWindows = monthsInRange(range)

  const [cogsPair, settings, accounts] = await Promise.all([
    cogsForRanges(db, monthWindows, range),
    getBusinessSettingsCollection(db).findOne({ key: 'business' }),
    loadAccounts(db),
  ])
  const cogs = cogsPair.cogs
  const cogsPerMonth = cogsPair.cogsPerMonth

  const pl = computeProfitLoss(entriesInRange, { cogs })
  const policy = resolveBusinessPolicy(settings)
  const advertising = advertisingSpend(entriesInRange, policy.advertisingCategories)
  const byCategory = expenseByCategory(entriesInRange)

  const accountHistory = accounts.map((a) => ({
    _id: a._id!.toString(),
    name: a.name,
    kind: a.kind,
    isActive: a.isActive,
    openingBalance: a.openingBalance,
  }))
  const flow: CashFlow = computeCashFlow(accountHistory, entriesBefore, entriesInRange)
  const balances = computeAccountBalances(accountHistory, ledgerUpToNow)
  const avg = computeAverages(entriesInRange, range)
  const granularity = pickGranularity(range)

  return {
    // ---- Money blocks require finance.view; the profit chain also needs sales ----
    ...(canView(viewable, 'sales')
      ? {
          profit: {
            revenue: money(pl.revenue),
            revenueCount: pl.revenueCount,
            netSales: money(pl.netSales),
            refunds: money(pl.refunds),
            cogs: money(pl.cogs),
            cogsProvisional: pl.cogsProvisional,
            cogsSource: pl.cogsSource,
            grossProfit: money(pl.grossProfit),
            operatingExpenses: money(pl.operatingExpenses),
            netProfit: money(pl.netProfit),
            // METRICS §G: numerator is the engine's net profit; divided by calendar
            // days, rounded once. An empty period yields 0, never NaN.
            netProfitPerDay: money(Math.round(pl.netProfit / Math.max(1, karachiDayCount(range)))),
          } satisfies ProfitBlock,
        }
      : {}),

    // ---- Expenses + advertising (METRICS §A.6/§A.7) ----
    expenses: {
      total: money(sumOperatingExpenses(entriesInRange)),
      advertising: money(advertising),
      advertisingCategories: policy.advertisingCategories,
      byCategory: byCategory.map((row) => ({ category: row.category, amount: money(row.paisa) })),
    },

    // ---- Cash: flow over the period + current balances (METRICS §B) ----
    cash: {
      cashIn: money(flow.cashIn),
      cashOut: money(flow.cashOut),
      netCashFlow: money(flow.netCashFlow),
      revenueIn: money(flow.revenueIn),
      operatingOut: money(flow.operatingOut),
      capitalIn: money(flow.capitalIn),
      withdrawalsOut: money(flow.withdrawalsOut),
      transferCount: flow.transferCount,
      totalBalanceStart: money(flow.totalBalanceStart),
      totalBalanceEnd: money(flow.totalBalanceEnd),
      accounts: accountHistory.map((a) => ({
        accountId: a._id,
        name: a.name,
        kind: a.kind,
        balance: money(balances[a._id] ?? 0),
      })),
    },

    // ---- Averages over the range (METRICS §G) ----
    averages: {
      days: Math.max(1, karachiDayCount(range)),
      perDay: money(avg.perDay),
      perWeek: money(avg.perWeek),
      perMonth: money(avg.perMonth),
      perEntry: money(avg.perEntry),
    },

    // ---- Chart series (METRICS §K) ----
    // Both series read `entriesInRange` — the identical slice the headline P&L
    // above was built from — so the bars and the figures can never disagree.
    trend: {
      granularity,
      salesVsExpenses: buildSalesExpenseSeries(entriesInRange, range, granularity),
      profitTrend: monthlyProfitSeries(entriesInRange, monthWindows, cogsPerMonth),
    },
  }
}

/** Inventory (METRICS §C) — inventory.view. */
async function buildInventoryBlock(db: Db): Promise<InventoryBlock> {
  const summary = await buildStockSummary(db)
  return {
    totalValue: money(summary.totals.totalValuation),
    lowStockCount: summary.totals.lowStockCount,
    byLocation: summary.totals.byLocation.map((loc) => ({
      location: loc.location,
      label: LOCATION_LABELS[loc.location] ?? loc.location,
      value: money(loc.valuation),
    })),
  }
}

/**
 * Orders / returns (METRICS §D, §A.2) — sales.view, aggregate pipelines. The
 * three pipelines are independent, so they overlap as they already did.
 */
async function buildOrdersBlock(db: Db, range: DateRange): Promise<OrdersBlock> {
  const inRange = { $gte: range.start, $lte: range.end }
  const ordersCol = getOrderCollection(db)

  const [statusRows, valueRows, returnsAgg] = await Promise.all([
    ordersCol
      .aggregate([
        { $match: { createdAt: inRange } },
        { $group: { _id: '$orderStatus', count: { $sum: 1 } } },
      ])
      .toArray(),
    ordersCol
      .aggregate([
        { $match: { createdAt: inRange, orderStatus: { $ne: 'cancelled' } } },
        { $group: { _id: null, count: { $sum: 1 }, value: { $sum: '$total' } } },
      ])
      .toArray(),
    getReturnCollection(db)
      .aggregate([
        { $match: { createdAt: inRange } },
        { $group: { _id: null, count: { $sum: 1 }, refundAmount: { $sum: '$refundAmount' } } },
      ])
      .toArray(),
  ])

  const byStatus: Record<string, number> = {}
  for (const row of statusRows as Array<{ _id: string | null; count: number }>) {
    byStatus[row._id ?? 'unknown'] = row.count
  }
  const valueRow = (valueRows as Array<{ count?: number; value?: number }>)[0]

  return {
    count: (valueRow?.count as number) ?? 0,
    grossOrderValue: money((valueRow?.value as number) ?? 0),
    byStatus,
    cancellations: byStatus.cancelled ?? 0,
    returns: {
      count: ((returnsAgg as Array<{ count?: number }>)[0]?.count as number) ?? 0,
      refundAmount: money(
        ((returnsAgg as Array<{ refundAmount?: number }>)[0]?.refundAmount as number) ?? 0
      ),
    },
  }
}

/**
 * Budget vs actual (METRICS §E) — budget.view. The thresholds and the
 * overlapping budgets come from different collections, so they are read
 * together; the actuals are then computed in memory exactly as before.
 */
async function buildBudgetBlocks(
  db: Db,
  range: DateRange,
  ledgerUpToNow: LedgerRow[]
): Promise<BudgetBlock[]> {
  const [thresholds, overlapping] = await Promise.all([
    loadBudgetThresholds(db),
    getBudgetCollection(db)
      .find({
        status: 'active',
        periodStart: { $lte: range.end },
        periodEnd: { $gte: range.start },
      } as never)
      .sort({ periodStart: -1 })
      .toArray(),
  ])

  // computeBudgetActuals filters internally to each budget's own period, so the
  // full ledger array is the correct input; `totalActual` therefore equals the
  // matching operating-expense slice (asserted by the reconciliation engine).
  return overlapping.map((b) => ({
    id: b._id!.toString(),
    name: b.name,
    periodStart: b.periodStart.toISOString(),
    periodEnd: b.periodEnd.toISOString(),
    actuals: computeBudgetActuals(
      { categories: b.categories, periodStart: b.periodStart, periodEnd: b.periodEnd },
      ledgerUpToNow,
      thresholds
    ),
  }))
}

/**
 * Completed / overdue counts over the range, mirroring the exact Phase 6 board
 * semantics already used by /api/reports/period (completedAt in range; overdue =
 * dueDate passed and the card is not sitting in a done column). These are read
 * queries, not financial formulas, so they are re-expressed against the board
 * model rather than duplicated from a calculation module.
 */
async function buildTasksBlock(db: Db, range: DateRange, now: Date): Promise<TasksBlock> {
  const inRange = { $gte: range.start, $lte: range.end }
  const doneColumns = await getColumnCollection(db)
    .find({ isDoneColumn: true } as never)
    .project<{ _id: ObjectId }>({ _id: 1 })
    .toArray()
  const doneColumnIds = doneColumns.map((c) => c._id)
  const tasksCol = getTaskDocCollection(db)

  const [completedCount, completedRows, overdueRows] = await Promise.all([
    tasksCol.countDocuments({ completedAt: inRange, isArchived: false } as never),
    tasksCol
      .aggregate([
        { $match: { completedAt: inRange, isArchived: false } },
        { $unwind: { path: '$assigneeIds', preserveNullAndEmptyArrays: true } },
        { $group: { _id: '$assigneeIds', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray(),
    tasksCol
      .aggregate([
        {
          $match: {
            isArchived: false,
            dueDate: { $lt: now, $ne: null },
            columnId: { $nin: doneColumnIds },
          },
        },
        { $unwind: { path: '$assigneeIds', preserveNullAndEmptyArrays: true } },
        { $group: { _id: '$assigneeIds', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray(),
  ])

  const assigneeRows = [
    ...(completedRows as Array<{ _id: unknown }>),
    ...(overdueRows as Array<{ _id: unknown }>),
  ]
  const assigneeIds = assigneeRows
    .map((row) => row._id)
    .filter((id): id is ObjectId => id instanceof ObjectId)
  const nameById = await resolveUsernames(db, assigneeIds)

  const describe = (list: unknown) =>
    (list as Array<{ _id: unknown; count: number }>).map((r) => ({
      name:
        r._id instanceof ObjectId
          ? (nameById.get(r._id.toString()) ?? 'Unknown member')
          : 'Unassigned',
      count: r.count,
    }))

  return {
    completed: completedCount,
    completedByMember: describe(completedRows),
    overdue: (overdueRows as Array<{ count: number }>).reduce((sum, r) => sum + r.count, 0),
    overdueByMember: describe(overdueRows),
  }
}

async function resolveUsernames(db: Db, ids: ObjectId[]): Promise<Map<string, string>> {
  const uniq = [...new Map(ids.map((id) => [id.toString(), id])).values()]
  const map = new Map<string, string>()
  if (uniq.length === 0) return map
  const users = await getUserCollection(db)
    .find({ _id: { $in: uniq } } as never)
    .project<{ _id: ObjectId; name: string }>({ _id: 1, name: 1 })
    .toArray()
  for (const u of users) map.set(String(u._id), u.name)
  return map
}
