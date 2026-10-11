import {
  computeAccountBalances,
  karachiDateInputRange,
  karachiDayRange,
  karachiMonthRange,
  karachiWeekRange,
  transactionEffect,
  type AccountLike,
  type DateRange,
  type LedgerEntryLike,
} from '@/lib/finance'

/**
 * Cash flow engine (Phase 4 brief item 4).
 *
 * Deliberately separate from accounting profit: P&L answers "did the month
 * make money", this answers "where did actual cash go". Two properties the
 * unit tests pin:
 *
 *   - **Transfers are neutral.** A transfer moves cash between accounts; it
 *     never appears as inflow or outflow of the business, so the total cash
 *     position is unchanged by it (§5.7's worked example).
 *   - **Capital in and withdrawals out are cash events** even though they are
 *     equity movements with no P&L effect — they belong here, not in the P&L.
 */

export interface CashFlowAccountLine {
  accountId: string
  name: string
  kind: string
  /** Cash at range start: opening balance + every effect before the range. */
  balanceStart: number
  cashIn: number
  cashOut: number
  /** Cash at range end: balanceStart + cashIn − cashOut. */
  balanceEnd: number
}

export interface CashFlow {
  cashIn: number
  cashOut: number
  netCashFlow: number
  /** Income receipts (operating cash in). */
  revenueIn: number
  /** Expenses paid (operating cash out). */
  operatingOut: number
  capitalIn: number
  withdrawalsOut: number
  /** Transfers are excluded from flows; the count is shown for transparency. */
  transferCount: number
  accounts: CashFlowAccountLine[]
  totalBalanceStart: number
  totalBalanceEnd: number
  count: number
}

interface AccountWithHistory extends AccountLike {
  name: string
  kind: string
}

/**
 * `entriesBefore` and `entriesInRange` must come from the same complete
 * ledger: opening positions are computed from history, flows from the range.
 */
export function computeCashFlow(
  accounts: AccountWithHistory[],
  entriesBefore: LedgerEntryLike[],
  entriesInRange: LedgerEntryLike[],
  options: { excludeInactive?: boolean } = {}
): CashFlow {
  const active = options.excludeInactive === false ? accounts : accounts.filter((a) => a.isActive !== false)

  const balancesStart = computeAccountBalances(active, entriesBefore)
  // computeAccountBalances on a fresh copy of the start balances gives the end
  // position without re-walking history.
  const balancesEnd = computeAccountBalances(
    active.map((a) => ({ _id: a._id, openingBalance: balancesStart[a._id] ?? 0, isActive: a.isActive })),
    entriesInRange
  )

  let revenueIn = 0
  let operatingOut = 0
  let capitalIn = 0
  let withdrawalsOut = 0
  let transferCount = 0

  const perAccount = new Map<string, { cashIn: number; cashOut: number }>()
  for (const account of active) perAccount.set(account._id, { cashIn: 0, cashOut: 0 })

  for (const entry of entriesInRange) {
    const effect = transactionEffect(entry)
    if (entry.type === 'transfer') {
      transferCount += 1
      continue
    }
    revenueIn += entry.type === 'income' ? effect.revenue : 0
    operatingOut += entry.type === 'expense' ? effect.expense : 0
    capitalIn += entry.type === 'partner_capital' ? effect.cashIn : 0
    withdrawalsOut += entry.type === 'partner_withdrawal' ? effect.cashOut : 0

    for (const [accountId, delta] of Object.entries(effect.accountDeltas)) {
      const line = perAccount.get(accountId) ?? { cashIn: 0, cashOut: 0 }
      if (delta >= 0) line.cashIn += delta
      else line.cashOut += -delta
      perAccount.set(accountId, line)
    }
  }

  const cashIn = revenueIn + capitalIn
  const cashOut = operatingOut + withdrawalsOut

  const lines: CashFlowAccountLine[] = active.map((account) => ({
    accountId: account._id,
    name: account.name,
    kind: account.kind,
    balanceStart: balancesStart[account._id] ?? 0,
    cashIn: perAccount.get(account._id)?.cashIn ?? 0,
    cashOut: perAccount.get(account._id)?.cashOut ?? 0,
    balanceEnd: balancesEnd[account._id] ?? 0,
  }))

  return {
    cashIn,
    cashOut,
    netCashFlow: cashIn - cashOut,
    revenueIn,
    operatingOut,
    capitalIn,
    withdrawalsOut,
    transferCount,
    accounts: lines,
    totalBalanceStart: lines.reduce((sum, line) => sum + line.balanceStart, 0),
    totalBalanceEnd: lines.reduce((sum, line) => sum + line.balanceEnd, 0),
    count: entriesInRange.length,
  }
}

/* -------------------------------------------------------------------------- */
/* Report range resolution (shared by P&L, cash flow and distribution routes)  */
/* -------------------------------------------------------------------------- */

export type ReportPeriod = 'day' | 'week' | 'month' | 'custom'

/**
 * Resolve `?period=…&date=YYYY-MM-DD` or `?from=…&to=…` into an inclusive
 * Karachi range. Day/week/month boundaries are Karachi midnights — the same
 * convention as every other reporting surface.
 */
export function resolveReportRange(searchParams: URLSearchParams): {
  period: ReportPeriod
  range: DateRange
} | null {
  const period = (searchParams.get('period') ?? 'month') as ReportPeriod

  if (period === 'custom') {
    const from = searchParams.get('from')
    const to = searchParams.get('to')
    const start = from ? karachiDateInputRange(from) : null
    const end = to ? karachiDateInputRange(to) : null
    if (!start || !end) return null
    if (end.start < start.start) return null
    return { period, range: { start: start.start, end: end.end } }
  }

  const dateParam = searchParams.get('date')
  const parsed = dateParam ? karachiDateInputRange(dateParam) : null
  if (dateParam && !parsed) return null
  const anchor = parsed ? parsed.start : new Date()

  const range =
    period === 'day' ? karachiDayRange(anchor) : period === 'week' ? karachiWeekRange(anchor) : karachiMonthRange(anchor)
  return { period, range }
}
