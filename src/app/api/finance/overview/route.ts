import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { handleRouteError, withAuth } from '@/lib/http'
import { successResponse } from '@/lib/api-response'
import { formatPaisa } from '@/lib/money'
import { periodTotals, summarize, type LedgerSummary } from '@/lib/finance'
import {
  buildSerializeContext,
  getAccountBalances,
  getWithdrawalLock,
  loadAccounts,
  loadCategories,
  normalizeEntry,
  serializeEntry,
} from '@/lib/finance-ledger'
import { getLedgerCollection } from '@/lib/models/Ledger'
import { serializeAccount } from '@/lib/finance-serializers'

const withSummaryDisplay = (summary: LedgerSummary) => ({
  ...summary,
  revenueDisplay: formatPaisa(summary.revenue),
  expenseDisplay: formatPaisa(summary.expense),
  netProfitDisplay: formatPaisa(summary.netProfit),
  cashInDisplay: formatPaisa(summary.cashIn),
  cashOutDisplay: formatPaisa(summary.cashOut),
  netCashFlowDisplay: formatPaisa(summary.netCashFlow),
  capitalDisplay: formatPaisa(summary.capital),
  withdrawalsDisplay: formatPaisa(summary.withdrawals),
  reinvestmentDisplay: formatPaisa(summary.reinvestment),
})

/**
 * GET /api/finance/overview
 *
 * One read that backs the Finance overview and the dashboard: account balances,
 * lifetime and day/week/month figures, recent transactions, and the withdrawal
 * lock state.
 */
async function __GET() {
  try {
    await authorize('finance', 'view')

    const db = await getDatabase()
    const [accounts, categories, entries, balancesResult, lock] = await Promise.all([
      loadAccounts(db),
      loadCategories(db),
      getLedgerCollection(db).find({}).sort({ date: -1, createdAt: -1 }).toArray(),
      getAccountBalances(db),
      getWithdrawalLock(db),
    ])

    const ctx = buildSerializeContext(accounts, categories)
    const balances = balancesResult.balances

    const normalized = entries.map(normalizeEntry)
    const overall = summarize(normalized)
    const periods = periodTotals(normalized, new Date())

    const totalCash = accounts.reduce(
      (sum, account) => sum + (balances[account._id!.toString()] ?? 0),
      0
    )

    return successResponse({
      accounts: accounts.map((account) =>
        serializeAccount(account, balances[account._id!.toString()] ?? 0)
      ),
      totalCash,
      totalCashDisplay: formatPaisa(totalCash),
      overall: withSummaryDisplay(overall),
      periods: {
        day: { ...periods.day, summary: withSummaryDisplay(periods.day.summary) },
        week: { ...periods.week, summary: withSummaryDisplay(periods.week.summary) },
        month: { ...periods.month, summary: withSummaryDisplay(periods.month.summary) },
      },
      recentTransactions: entries.slice(0, 8).map((entry) => serializeEntry(entry, ctx)),
      withdrawalLockedUntil: lock ? lock.toISOString() : null,
      withdrawalsLocked: lock ? Date.now() < lock.getTime() : false,
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
