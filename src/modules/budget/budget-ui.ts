/**
 * Budget screen view types (Phase 4).
 *
 * These mirror the JSON from /api/budgets and /api/budgets/[id] exactly —
 * the API serializes Dates to ISO strings and never ships ObjectIds, so
 * nothing here needs converting before rendering. Actuals arrive already
 * computed from the ledger; the UI never invents or types a figure.
 */

export type BudgetStatusView = 'draft' | 'active' | 'archived'
export type BudgetWarningLevelView = 'ok' | 'warning' | 'critical'
export type BudgetPeriodKindView = 'weekly' | 'monthly' | 'custom'

export interface BudgetCategoryRow {
  category: string
  budgeted: number
  actual: number
  remaining: number
  percentUsed: number
  level: BudgetWarningLevelView
}

export interface BudgetSourceEntry {
  _id: string
  type: string
  category: string
  date: string
  amount: number
  note?: string
}

export interface BudgetWarning {
  category: string
  level: 'warning' | 'critical'
  percentUsed: number
  threshold: number
}

export interface BudgetView {
  _id: string
  budgetNumber?: string
  name: string
  periodKind: BudgetPeriodKindView
  periodStart: string
  periodEnd: string
  status: BudgetStatusView
  /** The allocations merged with live actuals — one row per category. */
  categories: BudgetCategoryRow[]
  totalBudgeted: number
  totalActual: number
  totalRemaining: number
  percentUsed: number
  level: BudgetWarningLevelView
  warnings: BudgetWarning[]
  approvedBy?: string
  approvedAt?: string
  revisionCount: number
  createdAt: string
  updatedAt: string
}

export interface BudgetRevisionView {
  revisedAt: string
  revisedBy: string
  revisedByName?: string
  changes: string[]
  previous: {
    name: string
    periodStart: string
    periodEnd: string
    status: BudgetStatusView
    categories: { category: string; budgeted: number }[]
    totalBudgeted: number
  }
}

export interface BudgetDetailView extends BudgetView {
  sourceEntries: BudgetSourceEntry[]
  revisions: BudgetRevisionView[]
}

/** Label map from /api/finance/categories (name -> display label). */
export type CategoryLabels = Record<string, string>

/** Human label for a category key; falls back to a prettified name. */
export const categoryLabel = (name: string, labels: CategoryLabels): string =>
  labels[name] ?? name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export const PERIOD_KIND_LABEL: Record<BudgetPeriodKindView, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  custom: 'Custom',
}

export const BUDGET_STATUS_LABEL: Record<BudgetStatusView, string> = {
  draft: 'Draft',
  active: 'Active',
  archived: 'Archived',
}

export const WARNING_LEVEL_LABEL: Record<BudgetWarningLevelView, string> = {
  ok: 'Within budget',
  warning: 'Near limit',
  critical: 'Over limit',
}

export const WARNING_LEVEL_BADGE: Record<BudgetWarningLevelView, 'default' | 'warning' | 'error'> = {
  ok: 'default',
  warning: 'warning',
  critical: 'error',
}

/**
 * Idempotency key for one form session: a retry of the same submission
 * replays the first result server-side instead of double-creating. Re-exported
 * from the Phase 3 finance helpers so both phases share one implementation.
 */
export { newIdempotencyKey } from '@/modules/finance/finance-ui'
