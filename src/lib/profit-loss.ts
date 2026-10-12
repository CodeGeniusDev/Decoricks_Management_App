import { transactionEffect, type LedgerEntryLike, type DateRange } from '@/lib/finance'

/**
 * Profit & Loss engine (SPEC §5.1–§5.5).
 *
 * Everything is computed from the append-only ledger with signed amounts, so
 * reversals cancel their originals automatically and every figure traces back
 * to transaction records. The bucketing the Founder confirmed for Phase 4:
 *
 *   Revenue      = all income entries
 *   Refunds      = expense entries in `refunds_return_costs` (net-sales deduction)
 *   Net Sales    = Revenue − Refunds                     (§5.2)
 *   COGS         = provided by the inventory module (§5.3); until Phase 5 the
 *                  `product_purchasing` ledger total stands in and the figure
 *                  is explicitly PROVISIONAL
 *   Gross Profit = Net Sales − COGS                     (§5.4)
 *   Operating    = every other expense category         (§5.5)
 *   Net Profit   = Gross Profit − Operating             (§5.5)
 *
 * Purchasing never appears in both COGS and operating expenses, so the same
 * paisa are never counted twice.
 */

export const PL_CATEGORY_REFUNDS = 'refunds_return_costs'
export const PL_CATEGORY_PURCHASING = 'product_purchasing'

/** The Phase 5 seam: supply real weighted-average COGS when it exists. */
export interface CogsInput {
  /** Integer paisa. */
  amount: number
  /** False only when derived from inventory movements (§5.3 proper). */
  provisional: boolean
  /** Short label of where the number came from, shown in the calc panel. */
  source: string
}

export interface PlExpenseLine {
  category: string
  amount: number // paisa, signed (reversals included)
  count: number
}

export interface ProfitLoss {
  revenue: number
  revenueCount: number
  refunds: number
  netSales: number
  cogs: number
  cogsProvisional: boolean
  cogsSource: string
  grossProfit: number
  operatingExpenses: number
  netProfit: number
  /** Operating expense categories, largest first — the §5.5 breakdown. */
  operatingLines: PlExpenseLine[]
  /** Income categories, largest first. */
  revenueLines: PlExpenseLine[]
  count: number
}

/** Resolve COGS for a period: inventory-provided if given, purchasing stand-in otherwise. */
export function resolveCogs(entries: LedgerEntryLike[], provided?: CogsInput | null): CogsInput {
  if (provided) return provided
  const purchasing = sumExpenseByCategory(entries, PL_CATEGORY_PURCHASING)
  return { amount: purchasing, provisional: true, source: 'ledger product_purchasing (no inventory data yet)' }
}

const sumExpenseByCategory = (entries: LedgerEntryLike[], category: string): number =>
  entries
    .filter((entry) => entry.type === 'expense' && entry.category === category)
    .reduce((sum, entry) => sum + transactionEffect(entry).expense, 0)

const linesByCategory = (
  entries: LedgerEntryLike[],
  type: 'income' | 'expense',
  exclude: string[] = []
): PlExpenseLine[] => {
  const map = new Map<string, PlExpenseLine>()
  for (const entry of entries) {
    if (entry.type !== type || !entry.category || exclude.includes(entry.category)) continue
    const effect = transactionEffect(entry)
    const amount = type === 'income' ? effect.revenue : effect.expense
    const line = map.get(entry.category) ?? { category: entry.category, amount: 0, count: 0 }
    line.amount += amount
    line.count += 1
    map.set(entry.category, line)
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount)
}

/**
 * The whole §5 P&L chain for one set of ledger entries. Callers pass the
 * entries already narrowed to the reporting range (Karachi boundaries are the
 * route's job — see `karachiMonthRange` et al.).
 */
export function computeProfitLoss(
  entries: LedgerEntryLike[],
  options: { cogs?: CogsInput | null } = {}
): ProfitLoss {
  const revenueEntries = entries.filter((entry) => entry.type === 'income')
  const revenue = revenueEntries.reduce((sum, e) => sum + transactionEffect(e).revenue, 0)

  const refunds = sumExpenseByCategory(entries, PL_CATEGORY_REFUNDS)
  const netSales = revenue - refunds

  const cogs = resolveCogs(entries, options.cogs ?? null)
  const grossProfit = netSales - cogs.amount

  const operatingLines = linesByCategory(entries, 'expense', [
    PL_CATEGORY_REFUNDS,
    PL_CATEGORY_PURCHASING,
  ])
  const operatingExpenses = operatingLines.reduce((sum, line) => sum + line.amount, 0)
  const netProfit = grossProfit - operatingExpenses

  return {
    revenue,
    revenueCount: revenueEntries.length,
    refunds,
    netSales,
    cogs: cogs.amount,
    cogsProvisional: cogs.provisional,
    cogsSource: cogs.source,
    grossProfit,
    operatingExpenses,
    netProfit,
    operatingLines,
    revenueLines: linesByCategory(revenueEntries, 'income'),
    count: entries.length,
  }
}

/* -------------------------------------------------------------------------- */
/* Monthly trend series (chart + distribution history)                         */
/* -------------------------------------------------------------------------- */

export interface MonthlyPlPoint {
  /** 'YYYY-MM' Karachi month key. */
  month: string
  label: string
  netSales: number
  grossProfit: number
  operatingExpenses: number
  netProfit: number
  count: number
}

/**
 * One P&L point per Karachi month over the trailing `months` window ending at
 * `until`. Powers the monthly profit-trend chart and any multi-month review.
 * `cogsPerMonth`, when supplied, must align index-for-index with
 * `monthRanges` — the Phase 5 movement-derived COGS for each month (null
 * entries keep the provisional purchasing stand-in for that month).
 */
export function monthlyProfitSeries(
  entries: LedgerEntryLike[],
  monthRanges: { month: string; label: string; range: DateRange }[],
  cogsPerMonth?: (CogsInput | null)[]
): MonthlyPlPoint[] {
  return monthRanges.map(({ month, label, range }, index) => {
    const inRange = entries.filter((entry) => {
      const time = new Date(entry.date).getTime()
      return time >= range.start.getTime() && time <= range.end.getTime()
    })
    const pl = computeProfitLoss(inRange, { cogs: cogsPerMonth?.[index] ?? null })
    return {
      month,
      label,
      netSales: pl.netSales,
      grossProfit: pl.grossProfit,
      operatingExpenses: pl.operatingExpenses,
      netProfit: pl.netProfit,
      count: pl.count,
    }
  })
}
