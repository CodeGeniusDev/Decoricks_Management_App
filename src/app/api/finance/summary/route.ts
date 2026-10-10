import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { NextResponse } from 'next/server'
import { getDatabase } from '@/lib/mongodb'
import { formatPaisa } from '@/lib/money'
import { isWithin, karachiMonthRange, summarize } from '@/lib/finance'
import {
  buildSerializeContext,
  loadAccounts,
  loadCategories,
  normalizeEntry,
  serializeEntry,
} from '@/lib/finance-ledger'
import { getLedgerCollection } from '@/lib/models/Ledger'

/**
 * GET /api/finance/summary
 *
 * Month-to-date figures for the dashboard, now backed by the unified ledger.
 * Kept (rather than deleted with the Phase 1 collections) so existing callers
 * keep working; the figures are derived from `transactions`, not the retired
 * `income`/`expenses` collections.
 */
async function __GET() {
  try {
    await authorize('finance', 'view')

    const db = await getDatabase()
    const month = karachiMonthRange(new Date())
    const collection = getLedgerCollection(db)

    const [monthEntries, recentIncome, recentExpenses, accounts, categories] = await Promise.all([
      collection.find({ date: { $gte: month.start, $lte: month.end } }).toArray(),
      collection.find({ type: 'income' }).sort({ date: -1, createdAt: -1 }).limit(5).toArray(),
      collection.find({ type: 'expense' }).sort({ date: -1, createdAt: -1 }).limit(5).toArray(),
      loadAccounts(db),
      loadCategories(db),
    ])

    const ctx = buildSerializeContext(accounts, categories)
    const summary = summarize(monthEntries.map(normalizeEntry))
    const mtdTransfers = monthEntries
      .filter((entry) => entry.type === 'transfer')
      .reduce((sum, entry) => sum + (entry.isReversal ? -entry.amount : entry.amount), 0)

    const netCashFlow = summary.netCashFlow

    return NextResponse.json({
      success: true,
      data: {
        mtdIncome: summary.revenue,
        mtdIncomeDisplay: formatPaisa(summary.revenue),
        mtdExpenses: summary.expense,
        mtdExpensesDisplay: formatPaisa(summary.expense),
        mtdTransfers,
        netCashFlow,
        netCashFlowDisplay: formatPaisa(netCashFlow),
        recentIncome: recentIncome.map((entry) => serializeEntry(entry, ctx)),
        recentExpenses: recentExpenses.map((entry) => serializeEntry(entry, ctx)),
        timestamp: new Date().toISOString(),
      },
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
