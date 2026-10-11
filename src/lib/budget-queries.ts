import { Db } from 'mongodb'
import { getLedgerCollection, getBusinessSettingsCollection } from '@/lib/models/Ledger'
import type { BudgetThresholds } from '@/lib/models/Ledger'
import { resolveBusinessPolicy, SPEC_DEFAULT_BUDGET_THRESHOLDS } from '@/lib/business-policy'
import type { LedgerEntryLike, DateRange } from '@/lib/finance'

/**
 * Shared read helpers for the budget views.
 *
 * Actuals are computed from the ledger on every read (Phase 4 brief: never
 * typed in), so the only server-side data need is the expense entries that
 * overlap the requested window, in the exact shape the pure engines consume.
 */

/** Effective threshold configuration for warnings; SPEC defaults when unset. */
export async function loadBudgetThresholds(db: Db): Promise<BudgetThresholds> {
  const settings = await getBusinessSettingsCollection(db).findOne({ key: 'business' })
  return resolveBusinessPolicy(settings).budgetThresholds ?? SPEC_DEFAULT_BUDGET_THRESHOLDS
}

/**
 * Expense entries (including reversal entries, which carry negative effects)
 * whose date falls inside `range`. Nothing else is fetched: transfers, income
 * and equity entries can never change a budget actual.
 */
export async function fetchLedgerExpenses(db: Db, range: DateRange): Promise<LedgerEntryLike[]> {
  const rows = await getLedgerCollection(db)
    .find({
      type: 'expense',
      date: { $gte: range.start, $lte: range.end },
    })
    .project<LedgerEntryLike>({
      _id: 1,
      type: 1,
      amount: 1,
      date: 1,
      category: 1,
      isReversal: 1,
      note: 1,
    })
    .toArray()

  return rows.map((row) => ({
    _id: String(row._id),
    type: row.type as LedgerEntryLike['type'],
    amount: row.amount,
    date: row.date as Date,
    category: row.category,
    isReversal: row.isReversal,
    note: (row as { note?: string }).note,
  }))
}
