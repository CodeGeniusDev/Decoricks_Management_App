import { NextRequest } from 'next/server'
import { handleRouteError, withAuth } from '@/lib/http'
import { authorize } from '@/lib/authorization'
import { getDatabase } from '@/lib/mongodb'
import { successResponse, validationError } from '@/lib/api-response'
import { getLedgerCollection } from '@/lib/models/Ledger'
import { normalizeEntry, loadAccounts } from '@/lib/finance-ledger'
import { computeCashFlow, resolveReportRange } from '@/lib/cash-flow'

/**
 * GET /api/finance/cash-flow?period=…&date=… | ?from=…&to=…
 *
 * Cash movement, deliberately separate from accounting profit (Phase 4 brief
 * item 4): cash in, cash out, per-account balances across the range, and
 * partner capital / withdrawals — none of which touch the P&L. Transfers move
 * cash between accounts but are excluded from business-level flows, so the
 * totals are provably transfer-neutral.
 */
async function __GET(request: NextRequest) {
  try {
    await authorize('finance', 'view')

    const { searchParams } = new URL(request.url)
    const resolved = resolveReportRange(searchParams)
    if (!resolved) {
      return validationError('Invalid period', [
        { path: 'period', message: 'Provide a valid period with date, or from and to (YYYY-MM-DD)' },
      ])
    }
    const { period, range } = resolved

    const db = await getDatabase()
    const [accounts, docs] = await Promise.all([
      loadAccounts(db),
      getLedgerCollection(db).find({}).sort({ date: 1 }).toArray(),
    ])
    const entries = docs.map(normalizeEntry)

    const boundary = range.start.getTime()
    const before = entries.filter((entry) => new Date(entry.date).getTime() < boundary)
    const inRange = entries.filter(
      (entry) => {
        const t = new Date(entry.date).getTime()
        return t >= boundary && t <= range.end.getTime()
      }
    )

    const cashFlow = computeCashFlow(
      accounts.map((account) => ({
        _id: account._id!.toString(),
        name: account.name,
        kind: account.kind,
        openingBalance: account.openingBalance,
        isActive: account.isActive,
      })),
      before,
      inRange
    )

    return successResponse({
      period,
      range: { start: range.start.toISOString(), end: range.end.toISOString() },
      cashFlow,
      formulas: {
        netCashFlow: 'Cash In − Cash Out (transfers excluded)',
        cashIn: 'Income receipts + partner capital',
        cashOut: 'Expense payments + partner withdrawals',
        balanceEnd: 'Balance at period start + Cash In − Cash Out, per account',
      },
    })
  } catch (error) {
    console.error('GET /api/finance/cash-flow failed:', error)
    return handleRouteError(error)
  }
}

export const GET = withAuth(__GET)
