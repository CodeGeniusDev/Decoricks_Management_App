import { transactionEffect, type LedgerEntryLike } from '@/lib/finance'
import { PL_CATEGORY_PURCHASING, PL_CATEGORY_REFUNDS } from '@/lib/profit-loss'

/**
 * Phase 8 expense selectors (METRICS.md §A.6 / §A.7).
 *
 * These are the ONLY pieces of new money arithmetic in the dashboard layer, and
 * even they reuse the shared `transactionEffect` — no P&L formula is rewritten.
 * `computeProfitLoss` already yields `operatingExpenses` and `operatingLines`;
 * these selectors exist so the advertising split and the by-category rollup can
 * be computed (and unit-tested) against the exact same signed-effect walk.
 */

/** The two categories the P&L reserves for the net-sales / COGS chains. */
const RESERVED = new Set<string>([PL_CATEGORY_REFUNDS, PL_CATEGORY_PURCHASING])

/** A P&L operating expense: an expense entry outside the two reserved categories. */
export const isOperatingExpense = (entry: LedgerEntryLike): boolean =>
  entry.type === 'expense' && !!entry.category && !RESERVED.has(entry.category)

/** Sum of operating-expense effects (reversals reduce, via `transactionEffect`). */
export const sumOperatingExpenses = (entries: LedgerEntryLike[]): number =>
  entries.filter(isOperatingExpense).reduce((sum, e) => sum + transactionEffect(e).expense, 0)

/**
 * Revenue over any slice (§A.1): Σ income effects. Identical walk to
 * `computeProfitLoss`'s revenue line, exposed so the sales-vs-expenses trend can
 * bucket the SAME money the headline figure reports — never a second formula.
 */
export const sumRevenue = (entries: LedgerEntryLike[]): number =>
  entries
    .filter((e) => e.type === 'income')
    .reduce((sum, e) => sum + transactionEffect(e).revenue, 0)

/** Operating spend per category, largest first — the §A.6 breakdown. */
export const expenseByCategory = (
  entries: LedgerEntryLike[]
): Array<{ category: string; paisa: number }> => {
  const map = new Map<string, number>()
  for (const e of entries.filter(isOperatingExpense)) {
    map.set(
      e.category as string,
      (map.get(e.category as string) ?? 0) + transactionEffect(e).expense
    )
  }
  return [...map.entries()]
    .map(([category, paisa]) => ({ category, paisa }))
    .sort((a, b) => b.paisa - a.paisa)
}

/**
 * Advertising spend (§A.7): the subset of operating expenses whose category is
 * in the resolved advertising set. A strict subset of `sumOperatingExpenses`, so
 * it can never exceed total expenses regardless of what the set contains.
 */
export const advertisingSpend = (
  entries: LedgerEntryLike[],
  advertisingCategories: string[]
): number => {
  const set = new Set(advertisingCategories)
  return entries
    .filter((e) => isOperatingExpense(e) && set.has(e.category as string))
    .reduce((sum, e) => sum + transactionEffect(e).expense, 0)
}
