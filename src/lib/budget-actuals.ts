import {
  karachiCivil,
  karachiMidnight,
  karachiDayCount,
  isWithin,
  transactionEffect,
  type LedgerEntryLike,
} from '@/lib/finance'
import type { BudgetThresholds } from '@/lib/models/Ledger'
import { SPEC_DEFAULT_BUDGET_THRESHOLDS } from '@/lib/business-policy'

/**
 * Actual-vs-budget engine (Phase 4 brief items 1–2).
 *
 * Actuals are never typed in: they are computed from ledger expense entries
 * inside the budget period, with reversals counted as negatives
 * (`transactionEffect`), transfers and equity entries ignored entirely. A
 * budget's own document never stores an actual — the number is recomputed on
 * every read, so it can never go stale.
 *
 * Threshold levels use the configurable `{warning, critical}` percentages
 * (defaults from SPEC, resolved via `resolveBusinessPolicy` by the caller —
 * this module never hard-codes 80 or 100). The warning list is the hook the
 * future notification module will subscribe to.
 */

export type BudgetWarningLevel = 'ok' | 'warning' | 'critical'

export interface BudgetCategoryActual {
  category: string
  /** Paisa allocated in the budget. */
  budgeted: number
  /** Paisa actually spent, computed from the ledger (signed, so reversals reduce it). */
  actual: number
  /** Paisa still available (budgeted − actual; negative means over budget). */
  remaining: number
  /** Whole percent of the allocation consumed; 0 when nothing was allocated. */
  percentUsed: number
  level: BudgetWarningLevel
}

export interface BudgetActualEntry {
  /** Internal id so the calc panel can link to the underlying records. */
  _id: string
  type: LedgerEntryLike['type']
  category: string
  date: string
  /** Signed paisa effect on expenses (reversals negative). */
  amount: number
  note?: string
}

export interface BudgetActuals {
  categories: BudgetCategoryActual[]
  totalBudgeted: number
  totalActual: number
  totalRemaining: number
  percentUsed: number
  level: BudgetWarningLevel
  /** Categories crossing a configured threshold — future notification feed. */
  warnings: {
    category: string
    level: Exclude<BudgetWarningLevel, 'ok'>
    percentUsed: number
    threshold: number
  }[]
  /** The ledger expense entries behind the figures, for the calc panel. */
  sourceEntries: BudgetActualEntry[]
}

/** Percentage consumed, clamped only for display logic at >=100 (never below 0). */
function percentOf(budgeted: number, actual: number): number {
  if (budgeted <= 0) return actual > 0 ? 100 : 0
  return Math.round((actual / budgeted) * 100)
}

function levelFor(percentUsed: number, thresholds: BudgetThresholds): BudgetWarningLevel {
  if (percentUsed >= thresholds.critical) return 'critical'
  if (percentUsed >= thresholds.warning) return 'warning'
  return 'ok'
}

/**
 * The inclusive Karachi-day range of a budget period. Stored periods are
 * day-granular; the end expands to 23:59:59.999 Karachi so entries posted late
 * in the local evening are inside the period they belong to.
 */
export function budgetPeriodRange(periodStart: Date, periodEnd: Date) {
  const startCivil = karachiCivil(periodStart)
  const endCivil = karachiCivil(periodEnd)
  return {
    start: karachiMidnight(startCivil.year, startCivil.month, startCivil.day),
    end: new Date(
      karachiMidnight(endCivil.year, endCivil.month, endCivil.day).getTime() + 24 * 60 * 60 * 1000 - 1
    ),
  }
}

/** Inclusive Karachi-day span of a stored budget period. */
export const budgetPeriodDayCount = (periodStart: Date, periodEnd: Date): number =>
  karachiDayCount(budgetPeriodRange(periodStart, periodEnd))

export type BudgetPeriodKind = 'weekly' | 'monthly' | 'custom'

/**
 * Derive the period kind from the dates: a whole Karachi calendar month is
 * monthly, a span of at most seven days is weekly, anything else custom.
 */
export function derivePeriodKind(periodStart: Date, periodEnd: Date): BudgetPeriodKind {
  const start = karachiCivil(periodStart)
  const end = karachiCivil(periodEnd)
  const days = budgetPeriodDayCount(periodStart, periodEnd)
  if (start.year === end.year && start.month === end.month && start.day === 1) {
    const daysInMonth = new Date(Date.UTC(start.year, start.month, 0)).getUTCDate()
    if (days === daysInMonth) return 'monthly'
  }
  if (days <= 7) return 'weekly'
  return 'custom'
}

/** When the client asserts a kind, the dates must actually match it. */
export function validatePeriodKind(
  kind: BudgetPeriodKind,
  periodStart: Date,
  periodEnd: Date
): string | null {
  const days = budgetPeriodDayCount(periodStart, periodEnd)
  if (kind === 'weekly' && days > 7) {
    return 'A weekly budget period must span at most 7 days'
  }
  if (kind === 'monthly') {
    const start = karachiCivil(periodStart)
    const end = karachiCivil(periodEnd)
    const daysInMonth = new Date(Date.UTC(start.year, start.month, 0)).getUTCDate()
    if (
      start.year !== end.year ||
      start.month !== end.month ||
      start.day !== 1 ||
      days !== daysInMonth
    ) {
      return 'A monthly budget period must cover one full Karachi calendar month'
    }
  }
  return null
}

/**
 * Compute actuals for one budget from ledger entries. `entries` may contain
 * any type; only expense entries inside the period (and matching a budgeted
 * category) contribute. Categories present in the ledger but absent from the
 * budget are NOT aggregated here — that is an unplanned-spend signal the
 * caller can derive by comparing with the P&L view.
 */
export function computeBudgetActuals(
  budget: {
    categories: { category: string; budgeted: number }[]
    periodStart: Date
    periodEnd: Date
  },
  entries: LedgerEntryLike[],
  thresholds: BudgetThresholds = SPEC_DEFAULT_BUDGET_THRESHOLDS
): BudgetActuals {
  const range = budgetPeriodRange(budget.periodStart, budget.periodEnd)

  const spentByCategory = new Map<string, number>()
  const sourceEntries: BudgetActualEntry[] = []

  for (const entry of entries) {
    if (entry.type !== 'expense' || !entry.category) continue
    const date = new Date(entry.date)
    if (!isWithin(date, range)) continue

    const effect = transactionEffect(entry)
    spentByCategory.set(entry.category, (spentByCategory.get(entry.category) ?? 0) + effect.expense)
    if (budget.categories.some((c) => c.category === entry.category)) {
      sourceEntries.push({
        _id: entry._id ?? '',
        type: entry.type,
        category: entry.category,
        date: date.toISOString(),
        amount: effect.expense,
        note: (entry as { note?: string }).note,
      })
    }
  }

  const categories: BudgetCategoryActual[] = budget.categories.map((allocation) => {
    const actual = spentByCategory.get(allocation.category) ?? 0
    const percentUsed = percentOf(allocation.budgeted, actual)
    return {
      category: allocation.category,
      budgeted: allocation.budgeted,
      actual,
      remaining: allocation.budgeted - actual,
      percentUsed,
      level: levelFor(percentUsed, thresholds),
    }
  })

  const totalBudgeted = categories.reduce((sum, c) => sum + c.budgeted, 0)
  const totalActual = categories.reduce((sum, c) => sum + c.actual, 0)
  const totalPercent = percentOf(totalBudgeted, totalActual)

  const warnings = categories
    .filter((c) => c.level !== 'ok')
    .map((c) => ({
      category: c.category,
      level: c.level as 'warning' | 'critical',
      percentUsed: c.percentUsed,
      threshold: c.level === 'critical' ? thresholds.critical : thresholds.warning,
    }))

  return {
    categories,
    totalBudgeted,
    totalActual,
    totalRemaining: totalBudgeted - totalActual,
    percentUsed: totalPercent,
    level: levelFor(totalPercent, thresholds),
    warnings,
    sourceEntries: sourceEntries.sort((a, b) => b.date.localeCompare(a.date)),
  }
}
